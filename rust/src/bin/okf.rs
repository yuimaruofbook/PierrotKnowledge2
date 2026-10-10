//! The `okf` command line (`src/bun/cli/main.ts`).
//!
//!   okf <command> [args] [--flag value]
//!
//! Exit codes: 0 ok, 1 tool error, 2 usage error. `ui` and `serve` are the Bun
//! server and are handed to the TypeScript CLI; see `okf::cli::main`.

/// Output is UTF-8. Rust's stdout already converts to UTF-16 when it is a
/// console, so Japanese text displays correctly there whatever the code page.
/// What the code page still decides is how a *pipe* is read back by the next
/// program (PowerShell decodes it with the console's output code page), and
/// how a Bun child writes to the console. So the console is switched to UTF-8
/// for the duration of the run and put back afterwards. Without a console the
/// calls fail and nothing changes.
#[cfg(windows)]
mod console {
    extern "system" {
        fn GetConsoleOutputCP() -> u32;
        fn SetConsoleOutputCP(code_page: u32) -> i32;
    }

    const UTF8: u32 = 65001;

    pub struct Utf8Output(Option<u32>);

    impl Utf8Output {
        pub fn enter() -> Self {
            // SAFETY: plain Win32 calls with no pointers; failure is reported
            // by a zero return and is harmless here.
            unsafe {
                let previous = GetConsoleOutputCP();
                if previous == 0 || previous == UTF8 || SetConsoleOutputCP(UTF8) == 0 {
                    return Self(None);
                }
                Self(Some(previous))
            }
        }
    }

    impl Drop for Utf8Output {
        fn drop(&mut self) {
            if let Some(previous) = self.0 {
                // SAFETY: as above.
                unsafe {
                    SetConsoleOutputCP(previous);
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod console {
    pub struct Utf8Output;

    impl Utf8Output {
        pub fn enter() -> Self {
            Self
        }
    }
}

fn main() {
    // Lossy rather than `args()`, which panics on an argument that is not
    // valid Unicode.
    let argv: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();

    let code = {
        let _console = console::Utf8Output::enter();
        okf::cli::main::run(&argv)
    };
    std::process::exit(code);
}
