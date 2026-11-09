import { getSystemErrorName } from "node:util";

import { ERRNO } from "@earendil-works/gondolin";

/** Node-style errno error for VFS providers (gondolin's createErrnoError is not public). */
export function createErrnoError(name: "ENOSPC" | "ENOSYS", syscall: string, path?: string): NodeJS.ErrnoException {
  const errno = ERRNO[name];
  // ERRNO values from gondolin are positive; getSystemErrorName expects negative.
  let code: string;
  try {
    code = getSystemErrorName(-errno);
  } catch {
    code = name;
  }
  const message = path
    ? `${code}: ${syscall} '${path}'`
    : `${code}: ${syscall}`;
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  error.errno = errno;
  error.syscall = syscall;
  if (path) error.path = path;
  return error;
}
