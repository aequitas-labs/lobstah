// The site's Worker. It does one thing of its own: a request for
// www.lobstah.dev is sent to lobstah.dev, path and query kept. Everything
// else is the static files, served by Cloudflare from the build.

/** The one address the site answers at. */
export const HOME = 'lobstah.dev';

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === `www.${HOME}`) {
      url.hostname = HOME;
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
