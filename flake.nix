{
  description = "Development environment for the Syncpeer monorepo";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config = {
            allowUnfree = true;
            android_sdk.accept_license = true;
          };
        };

        android = {
          platformVersion = "36";
          buildToolsVersion = "35.0.0";
          ndkVersion = "26.3.11579264";
          cmakeVersion = "3.22.1";
          cmdLineToolsVersion = "13.0";
        };

        androidComposition = pkgs.androidenv.composeAndroidPackages {
          cmdLineToolsVersion = android.cmdLineToolsVersion;
          platformToolsVersion = "35.0.2";
          buildToolsVersions = [ android.buildToolsVersion ];
          platformVersions = [ android.platformVersion ];
          includeNDK = true;
          ndkVersions = [ android.ndkVersion ];
          cmakeVersions = [ android.cmakeVersion ];
        };

        androidSdk = androidComposition.androidsdk;
        androidSdkRoot = "${androidSdk}/libexec/android-sdk";
        jdk = pkgs.jdk17;
        appimageFhs = pkgs.buildFHSEnv {
          name = "syncpeer-appimage-fhs";
          targetPkgs = pkgs: with pkgs; [
            nodejs
            yarn
            rustup
            pkg-config
            openssl
            zlib
            gtk3
            webkitgtk_4_1
            libsoup_3
            (pkgs.lib.getOutput "out" glib)
            (pkgs.lib.getOutput "bin" glib)
            gsettings-desktop-schemas
            cairo
            pango
            gdk-pixbuf
            atk
            xdg-utils
          ];
          runScript = "bash";
        };
        buildAppImageScript = pkgs.writeShellScriptBin "syncpeer-build-appimage" ''
          set -euo pipefail
          umask 022
          repo_root="$PWD"
          shim_dir="$repo_root/.tmp/appimage-shim"
          run_id="$(date +%s)"
          tmp_dir="/tmp/syncpeer-appimage-tmp-$run_id"
          cache_dir="/tmp/syncpeer-appimage-cache-$run_id"
          home_dir="/tmp/syncpeer-appimage-home"
          rustup_home="''${RUSTUP_HOME:-$HOME/.rustup}"
          cargo_home="''${CARGO_HOME:-$HOME/.cargo}"
          mkdir -p "$tmp_dir" "$cache_dir" "$home_dir"
          mkdir -p "$shim_dir"
          cat > "$shim_dir/pkgconf" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "''${1:-}" == "--variable=schemasdir" && "''${2:-}" == "gio-2.0" ]]; then
  # On NixOS, returning a /nix/store schemas path makes linuxdeploy copy a read-only
  # tree into AppDir and then fail when glib-compile-schemas writes gschemas.compiled.
  # Use the FHS path so compilation happens in a writable AppDir/usr/share tree.
  echo "/usr/share/glib-2.0/schemas"
  exit 0
fi
exec ${pkgs.pkgconf}/bin/pkgconf "''$@"
EOF
          chmod +x "$shim_dir/pkgconf"
          ln -sf "$shim_dir/pkgconf" "$shim_dir/pkg-config"
          exec ${appimageFhs}/bin/syncpeer-appimage-fhs -lc "cd \"$repo_root\" && PATH=\"$shim_dir:\$PATH\" HOME=\"$home_dir\" RUSTUP_HOME=\"$rustup_home\" CARGO_HOME=\"$cargo_home\" CARGO_TARGET_DIR=\"$tmp_dir/cargo-target\" TMPDIR=\"$tmp_dir\" XDG_CACHE_HOME=\"$cache_dir\" XDG_DATA_DIRS=\"/usr/share:${pkgs.gsettings-desktop-schemas}/share:${pkgs.gtk3}/share\" RUST_BACKTRACE=1 APPIMAGE_EXTRACT_AND_RUN=1 /bin/bash -lc 'set -euo pipefail; echo \"[appimage-debug] id=\$(id -u):\$(id -g) user=\$(id -un) group=\$(id -gn)\"; echo \"[appimage-debug] run_id=$run_id\"; echo \"[appimage-debug] HOME=\$HOME\"; echo \"[appimage-debug] TMPDIR=\$TMPDIR\"; echo \"[appimage-debug] XDG_CACHE_HOME=\$XDG_CACHE_HOME\"; echo \"[appimage-debug] CARGO_TARGET_DIR=\$CARGO_TARGET_DIR\"; echo \"[appimage-debug] PATH=\$PATH\"; echo \"[appimage-debug] cargo=\$(command -v cargo || true)\"; echo \"[appimage-debug] rustc=\$(command -v rustc || true)\"; echo \"[appimage-debug] tauri=\$(command -v tauri || true)\"; mkdir -p \"\$CARGO_TARGET_DIR\" \"\$TMPDIR\" \"\$XDG_CACHE_HOME\"; ls -ld \"\$CARGO_TARGET_DIR\" \"\$TMPDIR\" \"\$XDG_CACHE_HOME\" \"\$HOME\"; stat -c \"[appimage-debug] %A %a %u:%g %n\" \"\$CARGO_TARGET_DIR\" \"\$TMPDIR\" \"\$XDG_CACHE_HOME\" \"\$HOME\"; npm run build -w @syncpeer/tauri-shell -- --verbose'"
        '';
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs
            yarn

            rustup
            gh

            pkg-config
            openssl
            tcpdump
            ripgrep

            gtk3
            webkitgtk_4_1
            libsoup_3
            glib
            cairo
            pango
            gdk-pixbuf
            atk
            xdg-utils

            jdk
            androidSdk

            gradle
          ];

          ANDROID_HOME = androidSdkRoot;
          ANDROID_SDK_ROOT = androidSdkRoot;
          NDK_HOME = "${androidSdkRoot}/ndk/${android.ndkVersion}";
          JAVA_HOME = "${jdk}";
          RUST_BACKTRACE = "1";

          shellHook = ''
            export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

            echo "Welcome to the Syncpeer development shell."
            echo "JAVA_HOME=$JAVA_HOME"
            echo "ANDROID_HOME=$ANDROID_HOME"
            echo "NDK_HOME=$NDK_HOME"

            if ! rustup show active-toolchain >/dev/null 2>&1; then
              echo
              echo "Initializing rustup stable toolchain..."
              rustup default stable
            fi

            echo
            echo "To enable Android Rust targets once, run:"
            echo "  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android"
          '';
        };

        packages.appimage-fhs = appimageFhs;
        apps.build-appimage = flake-utils.lib.mkApp {
          drv = buildAppImageScript;
        };
      });
}
