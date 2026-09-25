/// <reference types="@cloudflare/vitest-plugin/types" />

// Types the `cloudflare:test` helpers the specs still use (runInDurableObject,
// createExecutionContext, waitOnExecutionContext). The test `env` itself comes
// from `cloudflare:workers`, typed as `Cloudflare.Env` by `wrangler types`, so
// there is no ProvidedEnv augmentation here any more.
