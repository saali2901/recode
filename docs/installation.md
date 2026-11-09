# Manual installation

Most users only need the one-line installer from the [README](../README.md). These are the manual steps, e.g. for
unsupported systems.

## Node.js

ReCode needs Node.js 20.11 or newer; the current LTS release is recommended.

```bash
node --version      # v20.11+ / v22.x
```

Install from <https://nodejs.org/> or with a version manager such as `nvm`.

## ReCode

```bash
git clone <this repository> recode && cd recode
npm install
npm run build
npm link
```

`npm link` puts a `recode` command on your PATH. Without it, run `node dist/index.js <command>`.

## Ghidra

1. Install a **JDK 21 or newer** (`java -version`).
2. Download Ghidra from <https://github.com/NationalSecurityAgency/ghidra/releases> and unpack it, e.g. to
   `/opt/ghidra_11.x_PUBLIC`.
3. Tell ReCode where it is (any one of):

   ```bash
   export GHIDRA_INSTALL_DIR=/opt/ghidra_11.x_PUBLIC
   recode config set tools.ghidraInstallDir /opt/ghidra_11.x_PUBLIC --global
   ```

ReCode also searches `PATH` for `analyzeHeadless` and the usual installation directories (`/opt`, `/usr/local`,
`/usr/share`, `/Applications`, your home directory). The version is read from
`Ghidra/application.properties`. ReCode runs `support/analyzeHeadless` with its bundled export script
`src/decompiler/scripts/ExportAnalysis.java`; Ghidra compiles the script itself, no extra setup is needed.

## Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude          # start once and log in with your Claude subscription
claude auth status
```

ReCode uses the logged-in CLI; it never handles API keys. `recode doctor` checks the installation and the login.
Use `recode config set tools.claudeCommand /path/to/claude` if the command is not on `PATH`.

## C compiler, CMake, Ninja

| Platform      | Command                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| Debian/Ubuntu | `sudo apt install build-essential cmake ninja-build`                                      |
| Fedora        | `sudo dnf install gcc cmake ninja-build`                                                  |
| macOS         | `xcode-select --install && brew install cmake ninja`                                      |
| Windows       | Not tested. MSVC Build Tools + CMake + Ninja should work in a "Developer Command Prompt". |

## Verify

```bash
recode doctor
```

Every line should show `✓`. `recode analyze` needs Ghidra and Java, `recode reconstruct` needs Claude Code,
`recode build` needs compiler, CMake and Ninja; ReCode checks only what a command needs.
