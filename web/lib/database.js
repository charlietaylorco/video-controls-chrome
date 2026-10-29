"use strict";

// Service credentials stay server-side. SQL revokes direct browser access.
function createDatabase({ env, fetch: request = globalThis.fetch }) {
  const storageError = () => Object.assign(Error('storage_error'), { code: 'storage_error' });
  return {
    async rpc(name, args) {
      if (!/^rs_[a-z_]+$/.test(name)) throw Object.assign(Error('invalid_request'), { code: 'invalid_request' });
      let response;
      try {
        response = await request(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
          method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(args)
        });
      } catch { throw storageError(); }
      if (!response.ok) throw storageError();
      try { return await response.json(); } catch { throw storageError(); }
    }
  };
}

module.exports = { createDatabase };
