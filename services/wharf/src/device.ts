import { createAuthEndpoint, APIError } from 'better-auth/api';
import { deviceAuthorization, redeemDeviceCode } from 'better-auth/plugins/device-authorization';
import type { DeviceAuthorizationGrant } from 'better-auth/plugins/device-authorization';
import type { BetterAuthPlugin } from 'better-auth';
import { z } from 'zod';
import { boatName, digest, object } from './protocol.js';
import { boatPermissions, permits } from './permissions.js';
import type { Permission } from './permissions.js';
import { personSession } from './auth.js';

type BoatRequest = { account: string; name: string; permissions: Permission[]; id?: string; proof?: string; previousName?: string };
type Code = { id: string; userId?: string; status: string; expiresAt: Date; requestData: string; approvedGrants?: string };
function refuse(message: string): never { throw new APIError('FORBIDDEN', { error: 'access_denied', error_description: message }); }
function readRequest(code: { requestData?: unknown }): BoatRequest {
  if (typeof code.requestData !== 'string') refuse('not a boat enrolment code');
  return JSON.parse(code.requestData) as BoatRequest;
}
const permissionList = z.array(z.enum(['work', 'read', 'helm'])).max(3);
export function boatDevice(env: Env, glass: string) {
  const requestSchemaFields = {
        account: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
        steering: z.enum(['read', 'helm', 'none']).default('read'),
        boatToken: z.string().max(1024).optional(),
  };
  const grant = {
      requestSchemaFields,
      deviceCodeSchemaFields: { requestData: { type: 'string', required: true }, approvedGrants: { type: 'string', required: false } },
      authorizeRequest: async ({ request }: Parameters<DeviceAuthorizationGrant['authorizeRequest']>[0]) => {
        if (request.client_id !== 'lobstah-cli' || request.user_id || request.scope) refuse('invalid boat enrolment request');
        const input = z.object(requestSchemaFields).parse(request);
        const data: BoatRequest = { account: input.account, name: boatName(input.name), permissions: input.steering === 'none' ? ['work'] : ['work', input.steering] };
        if (input.boatToken) {
          if (!input.boatToken.startsWith(`b.${data.account}.`)) refuse('current boat credential does not belong to these grounds');
          const own = object(JSON.parse(await env.ACCOUNTS.getByName(data.account).handle(JSON.stringify({ account: data.account, helm: false, token: input.boatToken, method: 'GET', path: '_boat', body: {} }))));
          if (own.status !== 200) refuse('current boat credential is invalid');
          const boat = object(own.value); if (typeof boat.id !== 'string' || typeof boat.name !== 'string') refuse('invalid current boat');
          data.id = boat.id; data.previousName = boat.name; data.proof = await digest(input.boatToken.split('.').at(-1)!);
        }
        return { clientId: 'lobstah-cli', deviceCodeFields: { requestData: JSON.stringify(data) } };
      },
      assertSessionRedemption: () => refuse('boat approval never issues a person session'),
      getVerificationContext: (code) => {
        const requested = readRequest(code);
        return { boatName: requested.name, previousBoatName: requested.previousName, requestedPermissions: requested.permissions,
          description: requested.permissions.includes('helm') ? 'Work, see the grounds state, and steer dispatches and the helm seat.' : requested.permissions.includes('read') ? 'Work and see the grounds state.' : 'Work only; cannot see the grounds state or steer.' };
      },
  } satisfies DeviceAuthorizationGrant;
  const plugin = deviceAuthorization<typeof grant>({ validateClient: (id) => id === 'lobstah-cli', verificationUri: `${glass}/device`, grant });
  const issuer = {
    id: 'wharf-boat-device',
    endpoints: {
      approveBoat: createAuthEndpoint('/wharf/approve', {
        method: 'POST', requireHeaders: true,
        body: z.object({ userCode: z.string().min(1).max(128), name: z.string(), requestedPermissions: permissionList, permissions: permissionList }).strict(),
      }, async (ctx) => {
        const person = await personSession(env, ctx.headers!);
        const code = await ctx.context.adapter.findOne<Code>({ model: 'deviceCode', where: [{ field: 'userCode', value: ctx.body.userCode }] });
        if (!code || code.userId !== person.id || code.status !== 'pending' || new Date(code.expiresAt).getTime() <= Date.now()) refuse('claim this pending code in the browser first');
        const requested = readRequest(code);
        if (requested.account !== person.id || requested.name !== ctx.body.name || JSON.stringify(requested.permissions) !== JSON.stringify(ctx.body.requestedPermissions)) refuse('approval does not match the displayed boat and permissions');
        const selected = boatPermissions(ctx.body.permissions, false);
        if (selected.some((p) => !permits(requested.permissions, p))) refuse('approval may only keep or lower requested permissions');
        const updated = await ctx.context.adapter.incrementOne({ model: 'deviceCode', increment: {},
          where: [{ field: 'id', value: code.id }, { field: 'userId', value: person.id }, { field: 'status', value: 'pending' }],
          set: { status: 'approved', approvedGrants: JSON.stringify(selected) },
        });
        if (!updated) refuse('this approval was already processed');
        return ctx.json({ success: true, permissions: selected });
      }),
      boatToken: createAuthEndpoint('/wharf/token', {
        method: 'POST', body: z.object({ client_id: z.literal('lobstah-cli'), device_code: z.string().min(1).max(256), grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code') }).strict(),
      }, async (ctx) => {
        const result = await redeemDeviceCode<{ requestData: string; approvedGrants: string }, undefined, undefined>({
          ctx, deviceCode: ctx.body.device_code,
          authorizeRedemption: (code) => {
            if (code.clientId !== 'lobstah-cli') refuse('client mismatch');
            readRequest(code);
            return { ownershipWhere: { field: 'clientId', value: 'lobstah-cli' }, context: undefined };
          },
          prepareRedemption: async (code) => {
            const requested = readRequest(code);
            if (requested.account !== code.userId) refuse('approval belongs to another account');
            const provider = await env.AUTH_DB.prepare('SELECT accountId FROM account WHERE userId=? AND providerId=?').bind(code.userId, 'github').first<{ accountId: string }>();
            const invited: unknown = JSON.parse(env.GITHUB_ALLOWLIST);
            if (!Array.isArray(invited) || !invited.includes(provider?.accountId)) refuse('this wharf is invite-only');
            return undefined;
          },
        });
        const requested = readRequest(result.claimedDeviceCode);
        const issued = object(JSON.parse(await env.ACCOUNTS.getByName(requested.account).handle(JSON.stringify({
          account: requested.account, helm: true, personId: result.user.id, token: `device-${result.claimedDeviceCode.id}`,
          method: 'POST', path: 'boats', key: `device-${result.claimedDeviceCode.id}`, body: { name: requested.name, permissions: JSON.parse(result.claimedDeviceCode.approvedGrants), enrol: true, expectedBoat: requested.id, proof: requested.proof },
        }))));
        if (issued.status !== 201) throw new APIError('CONFLICT', { error: 'enrolment_failed', error_description: 'Boat enrolment failed; choose a new name or approve again with the current credential.' });
        return ctx.json({ ...object(issued.value), account: requested.account });
      }),
    },
  } satisfies BetterAuthPlugin;
  return [plugin, issuer] as const;
}
