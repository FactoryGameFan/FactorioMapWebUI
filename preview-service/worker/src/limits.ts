// A real request is about 2 KB: measured 1,902 to 2,094 bytes over the nine
// built-in presets. 64 KiB is room for any preset the app can build, and stops
// a client from making the Worker buffer a body it would only reject.
//
// Lives here, not in index.ts: workerd treats every named export of the entry
// module as an entrypoint, and a number is not one.
export const MAX_BODY_BYTES = 64 * 1024;
