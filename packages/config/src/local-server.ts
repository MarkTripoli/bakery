/**
 * The fixed address of a Bakery server on this computer with default settings
 * (#77). The server's runtime config reads its listener default from here, so
 * this is the one definition a client (the desktop app) and the server share.
 * Dependency-free on purpose: a client can import this file alone.
 */
export const LOCAL_SERVER_HOST = "127.0.0.1";

/** The port a Bakery server on this computer listens on unless told otherwise. */
export const LOCAL_SERVER_PORT = 8000;

/** The origin a client tries first for a server on this computer. */
export const LOCAL_SERVER_ORIGIN =
  `http://${LOCAL_SERVER_HOST}:${LOCAL_SERVER_PORT}`;
