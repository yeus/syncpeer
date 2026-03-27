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

            gtk3
            webkitgtk_4_1
            libsoup_3
            glib
            cairo
            pango
            gdk-pixbuf
            atk

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
      });
}