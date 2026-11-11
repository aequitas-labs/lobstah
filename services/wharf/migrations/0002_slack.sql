-- The wharf Slack app: one installation per workspace, each person's own link, and single-use connect states.
CREATE TABLE "slackInstallation" (team text primary key, botUser text not null, botToken text not null, scopes text not null, installedBy text not null, installedAt text not null);
CREATE TABLE "slackLink" (team text not null, slackUser text not null, person text not null, channel text not null, linkedAt text not null, revokedAt text, primary key (team, slackUser));
CREATE INDEX "slackLink_person_idx" on "slackLink" (person);
CREATE TABLE "slackConnect" (state text primary key, person text not null, sessionId text not null, expiresAt integer not null);
