// Hostinger's Node.js runtime (lsnode.js) loads the entry file via require(), which cannot load
// an ESM module containing top-level await (dist/server.js, built from src/server.ts, has one -
// ERR_REQUIRE_ASYNC_MODULE). A plain .cjs file has no such restriction, and a dynamic import()
// call inside it returns a promise without blocking require() itself. This file exists only on
// this throwaway deploy branch; it is not part of the real build output.
import('./server.js').catch((e) => {
  console.error(e);
  process.exit(1);
});
