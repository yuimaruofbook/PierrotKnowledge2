/**
 * What every part of the `okf` CLI agrees on: exit codes and its own name.
 */

import { APP_NAME } from "../../shared/app";

/** Exit codes mean something: 0 ok, 1 tool error, 2 usage error. */
export const EXIT_OK = 0;
export const EXIT_TOOL_ERROR = 1;
export const EXIT_USAGE = 2;

/**
 * How to type this command, in the shell the user is actually in.
 *
 * Setup does not put the install folder on PATH, and no shell runs a program
 * from the current directory unasked — PowerShell answers
 * `CommandNotFoundException`, a POSIX shell "command not found". Printing the
 * bare name told people to type something that cannot work, and they did.
 */
export const SELF = `${process.platform === "win32" ? ".\\" : "./"}${APP_NAME}`;
