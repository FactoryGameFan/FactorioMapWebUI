import { Container, type StopParams } from "@cloudflare/containers";

export class PreviewContainer extends Container {
  defaultPort = 8080;
  // One-shot renders: keep the idle tail short (memory is billed for the whole
  // awake window). The R2 cache absorbs repeat requests.
  sleepAfter = "20s";

  // Lifecycle hooks (containers/api/container-class), logged as one JSON object
  // per line like src/index.ts, so Workers Logs can filter on the fields.
  //
  // onStop is the only record of HOW an instance ended. In the installed
  // @cloudflare/containers (0.3.7) `reason` is always "exit" - the type also
  // names "runtime_signal", but nothing in the package sends it - so the exit
  // code is the field that carries information: 0 for a clean stop, such as
  // the SIGTERM handler in server.mjs after sleepAfter, anything else for a
  // crash or a kill. #120 was a container that never stopped at all, and only
  // the billing buckets showed it. With this a healthy instance leaves one
  // line per sleep, so a missing one shows up in the logs too.
  override onStop({ exitCode, reason }: StopParams): void {
    console.log(JSON.stringify({ message: "container stopped", exitCode, reason }));
  }

  // The package's default onError does console.error("Container error:", e)
  // and rethrows. Same contract here, with the line made structured. Rethrow
  // rather than swallow: every call site in @cloudflare/containers ignores what
  // this throws and then rethrows the original error itself, so throwing keeps
  // the base class's behaviour exactly, and a swallow would only mislead a
  // future caller that does read it.
  override onError(error: unknown): unknown {
    console.error(
      JSON.stringify({
        message: "container error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}
