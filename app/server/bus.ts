// WS broadcast seam. Modules emit live updates through broadcast() without
// importing the server; index.ts installs the real sender (its WS client set)
// at startup. Until then — e.g. under the selftest — broadcasts are no-ops.
type Broadcaster = (msg: unknown) => void;

let broadcaster: Broadcaster = () => {};

export function setBroadcaster(fn: Broadcaster) {
  broadcaster = fn;
}

export function broadcast(msg: unknown) {
  broadcaster(msg);
}
