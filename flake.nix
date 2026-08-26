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
            adwaita-icon-theme
            hicolor-icon-theme
            cairo
            pango
            gdk-pixbuf
            librsvg
            atk
            libdecor
            xdg-utils
            git
            libtiff
            fribidi
            harfbuzz
            fontconfig
            freetype
            libxft
            libx11
            libxext
            libxrender
            libxrandr
            libxinerama
            libxcursor
            libxdamage
            libxfixes
            libxcomposite
            libxi
            libxau
            libxdmcp
            libxcb
            libxkbcommon
            libglvnd
            libdrm
            mesa
            libgbm
            expat
            libgpg-error
            squashfsTools
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
          cache_dir="$repo_root/.tmp/appimage-cache"
          home_dir="/tmp/syncpeer-appimage-home"
          cargo_target_dir="$cache_dir/cargo-target"
          schemas_dir="$tmp_dir/glib-2.0/schemas"
          tools_dir="$cache_dir/tauri"
          appimage_plugin="$tools_dir/linuxdeploy-plugin-appimage.AppImage"
          appimage_plugin_extract="$cache_dir/linuxdeploy-plugin-appimage"
          gtk_stage_dir="$tmp_dir/gtk"
          gdk_stage_dir="$tmp_dir/gdk-pixbuf"
          rustup_home="''${RUSTUP_HOME:-$HOME/.rustup}"
          cargo_home="''${CARGO_HOME:-$HOME/.cargo}"
          mkdir -p "$tmp_dir" "$tools_dir" "$home_dir"
          # Older runs used a shell wrapper at this path. Restore the real
          # linuxdeploy binary so the cache remains usable after upgrading.
          if [ -x "$tools_dir/linuxdeploy-real.AppImage" ]; then
            cp "$tools_dir/linuxdeploy-real.AppImage" \
              "$tools_dir/linuxdeploy-x86_64.AppImage"
            chmod +x "$tools_dir/linuxdeploy-x86_64.AppImage"
          fi
          if [ ! -x "$appimage_plugin" ]; then
            ${pkgs.curl}/bin/curl --fail --location --silent --show-error \
              --output "$appimage_plugin" \
              https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage
            chmod +x "$appimage_plugin"
          fi
          if [ ! -x "$appimage_plugin_extract/usr/bin/linuxdeploy-plugin-appimage" ]; then
            plugin_offset="$(${pkgs.gnugrep}/bin/grep -abo 'hsqs' "$appimage_plugin" | cut -d: -f1 | while read -r offset; do
              if ${pkgs.squashfsTools}/bin/unsquashfs -offset "$offset" -s "$appimage_plugin" >/dev/null 2>&1; then
                printf '%s\n' "$offset"
                break
              fi
            done)"
            test -n "$plugin_offset"
            ${pkgs.squashfsTools}/bin/unsquashfs -f -d "$appimage_plugin_extract" \
              -offset "$plugin_offset" "$appimage_plugin" >/dev/null
            mv "$appimage_plugin" "$cache_dir/linuxdeploy-plugin-appimage-original.AppImage"
          fi
          cat > "$appimage_plugin" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

appdir="''${APPDIR:-}"
hook="$appdir/apprun-hooks/linuxdeploy-plugin-gtk.sh"
tmp_root="$appdir/tmp"

if [ -d "$appdir" ] && [ -d "$tmp_root" ]; then
  for staged_run in "$tmp_root"/*; do
    [ -d "$staged_run" ] || continue
    case "$staged_run" in
      "$tmp_root"/*) ;;
      *) continue ;;
    esac

    gtk_root="$staged_run/gtk"
    gdk_root="$staged_run/gdk-pixbuf"
    schemas_root="$staged_run/glib-2.0/schemas"

    if [ -d "$gtk_root/lib/gtk-3.0" ]; then
      mkdir -p "$appdir/usr/lib/gtk-3.0"
      cp -a "$gtk_root/lib/gtk-3.0/." "$appdir/usr/lib/gtk-3.0/"
      gtk_path="''${gtk_root#"$appdir"}"
      sed -i "s|''${gtk_path}|/usr|g" "$hook"
    fi

    if [ -d "$gdk_root/lib" ]; then
      mkdir -p "$appdir/usr/lib"
      cp -a "$gdk_root/lib/." "$appdir/usr/lib/"
      gdk_path="''${gdk_root#"$appdir"}"
      sed -i "s|''${gdk_path}|/usr|g" "$hook"
    fi

    if [ -d "$schemas_root" ]; then
      mkdir -p "$appdir/usr/share/glib-2.0/schemas"
      cp -a "$schemas_root/." "$appdir/usr/share/glib-2.0/schemas/"
      schemas_path="''${schemas_root#"$appdir"}"
      sed -i "s|''${schemas_path}|/usr/share/glib-2.0/schemas|g" "$hook"
    fi

    while IFS= read -r -d "" link; do
      target="$(readlink "$link")"
      destination=
      gtk_path="''${gtk_root#"$appdir"}"
      gdk_path="''${gdk_root#"$appdir"}"
      case "$target" in
        "$gtk_path"/*) destination="$appdir/usr''${target#"$gtk_path"}" ;;
        "$gdk_path"/*) destination="$appdir/usr''${target#"$gdk_path"}" ;;
      esac
      if [ -n "$destination" ] && [ -e "$destination" ]; then
        ln -sfn "$(realpath --relative-to="$(dirname "$link")" "$destination")" "$link"
      fi
    done < <(find "$appdir/usr" -type l -print0)

    rm -rf -- "$staged_run"
  done
  find "$tmp_root" -depth -type d -empty -delete
fi

if [ -L "$appdir/.DirIcon" ]; then
  diricon="$(readlink "$appdir/.DirIcon")"
  case "$diricon" in
    "$appdir"/*)
      ln -sfn "''${diricon#"$appdir/"}" "$appdir/.DirIcon"
      ;;
  esac
fi

wrapper_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
          exec "$wrapper_dir/../linuxdeploy-plugin-appimage/usr/bin/linuxdeploy-plugin-appimage" "$@"
EOF
          chmod +x "$appimage_plugin"
          appimagetool="$appimage_plugin_extract/usr/bin/appimagetool"
          appimagetool_real="$appimage_plugin_extract/usr/bin/appimagetool-real"
          if [ ! -x "$appimagetool_real" ]; then
            mv "$appimagetool" "$appimagetool_real"
          fi
          cat > "$appimagetool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

appdir="''${1:-}"
if [ -d "$appdir" ]; then
  gdk_stage="''${SYNCPEER_APPIMAGE_GDK_STAGE_DIR:-}"
  if [ -d "$gdk_stage/lib" ]; then
    mkdir -p "$appdir/usr/lib"
    while IFS= read -r -d "" library; do
      cp -L "$library" "$appdir/usr/lib/"
    done < <(find "$gdk_stage/lib" -maxdepth 1 -type f -print0)
  fi

  while IFS= read -r -d "" link; do
    target="$(readlink "$link")"
    destination=
    case "$target" in
      /tmp/*/gtk/*) destination="$appdir/usr''${target#*/gtk}" ;;
      /tmp/*/gdk-pixbuf/*) destination="$appdir/usr''${target#*/gdk-pixbuf}" ;;
    esac
    if [ -n "$destination" ] && [ -e "$destination" ]; then
      ln -sfn "$(realpath --relative-to="$(dirname "$link")" "$destination")" "$link"
    fi
  done < <(find "$appdir/usr" -type l -print0)
fi

tool_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
exec "$tool_dir/appimagetool-real" "$@"
EOF
          chmod +x "$appimagetool"
          mkdir -p "$schemas_dir"
          mkdir -p "$gtk_stage_dir/lib/gtk-3.0"
          cp -L -R ${pkgs.gtk3}/lib/gtk-3.0/. "$gtk_stage_dir/lib/gtk-3.0/"
          mkdir -p "$gdk_stage_dir/lib"
          cp -L ${pkgs.gdk-pixbuf}/lib/libgdk_pixbuf-2.0.so.0 \
            "$gdk_stage_dir/lib/"
          cp -L \
            ${pkgs.fribidi}/lib/libfribidi.so.0 \
            ${pkgs.harfbuzz}/lib/libharfbuzz.so.0 \
            ${pkgs.fontconfig.lib}/lib/libfontconfig.so.1 \
            ${pkgs.freetype}/lib/libfreetype.so.6 \
            ${pkgs.expat}/lib/libexpat.so.1 \
            ${pkgs.libgpg-error}/lib/libgpg-error.so.0 \
            ${pkgs.libx11}/lib/libX11.so.6 \
            ${pkgs.libx11}/lib/libX11-xcb.so.1 \
            ${pkgs.libxcb}/lib/libxcb.so.1 \
            ${pkgs.libgbm}/lib/libgbm.so.1 \
            ${pkgs.libdrm}/lib/libdrm.so.2 \
            ${pkgs.libglvnd}/lib/libEGL.so.1 \
            ${pkgs.libglvnd}/lib/libGLX.so.0 \
            ${pkgs.libglvnd}/lib/libGLdispatch.so.0 \
            ${pkgs.zlib}/lib/libz.so.1 \
            ${pkgs.stdenv.cc.cc.lib}/lib/libstdc++.so.6 \
            ${pkgs.stdenv.cc.cc.lib}/lib/libgcc_s.so.1 \
            "$gdk_stage_dir/lib/"
          cp -L ${pkgs.glib.out}/lib/libgobject-2.0.so.0 \
            ${pkgs.glib.out}/lib/libgio-2.0.so.0 \
            ${pkgs.librsvg}/lib/librsvg-2.so.2 \
            ${pkgs.pango.out}/lib/libpango-1.0.so.0 \
            ${pkgs.pango.out}/lib/libpangocairo-1.0.so.0 \
            ${pkgs.pango.out}/lib/libpangoft2-1.0.so.0 \
            "$gdk_stage_dir/lib/"
          mkdir -p "$gdk_stage_dir/lib/gdk-pixbuf-2.0/2.10.0/loaders"
          cp -L -R ${pkgs.gdk-pixbuf}/lib/gdk-pixbuf-2.0/2.10.0/. \
            "$gdk_stage_dir/lib/gdk-pixbuf-2.0/2.10.0/"
          cp -L -R ${pkgs.librsvg}/lib/gdk-pixbuf-2.0/2.10.0/loaders/. \
            "$gdk_stage_dir/lib/gdk-pixbuf-2.0/2.10.0/loaders/"
          chmod -R u+rwX "$gtk_stage_dir" "$gdk_stage_dir"
          cp -L -R ${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/*/glib-2.0/schemas/. "$schemas_dir/"
          chmod -R u+w "$schemas_dir"
          cp -L -R ${pkgs.gtk3}/share/gsettings-schemas/*/glib-2.0/schemas/. "$schemas_dir/"
          chmod -R u+w "$schemas_dir"
          rm -f "$schemas_dir/gschemas.compiled"
          mkdir -p "$shim_dir"
          cat > "$shim_dir/pkgconf" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "''${1:-}" == "--variable=schemasdir" && "''${2:-}" == "gio-2.0" ]]; then
  # On NixOS, returning a /nix/store schemas path makes linuxdeploy copy a read-only
  # tree into AppDir and then fail when glib-compile-schemas writes gschemas.compiled.
  # Use the FHS path so compilation happens in a writable AppDir/usr/share tree.
  echo "''${SYNCPEER_APPIMAGE_SCHEMAS_DIR:-/usr/share/glib-2.0/schemas}"
  exit 0
fi
if [[ "''${1:-}" == "--variable=exec_prefix" && "''${2:-}" == "gtk+-3.0" ]]; then
  # Keep the GTK plugin inside the FHS view.  The Nix store prefix is
  # read-only and would make the plugin copy an unwritable tree into AppDir.
  echo "''${SYNCPEER_APPIMAGE_GTK_STAGE_DIR:-/usr}"
  exit 0
fi
if [[ "''${1:-}" == "--variable=libdir" && "''${2:-}" == "gtk+-3.0" ]]; then
  echo "''${SYNCPEER_APPIMAGE_GTK_STAGE_DIR:-/usr}/lib"
  exit 0
fi
if [[ "''${1:-}" == "--variable=libdir" && "''${2:-}" == "gdk-pixbuf-2.0" ]]; then
  echo "''${SYNCPEER_APPIMAGE_GDK_STAGE_DIR:-/usr}/lib"
  exit 0
fi
if [[ "''${1:-}" == "--variable=libdir" ]]; then
  case "''${2:-}" in
    gobject-2.0|gio-2.0|librsvg-2.0|pango|pangocairo|pangoft2)
      echo "''${SYNCPEER_APPIMAGE_GDK_STAGE_DIR:-/usr}/lib"
      exit 0
      ;;
  esac
fi
if [[ "''${2:-}" == "gdk-pixbuf-2.0" ]]; then
  case "''${1:-}" in
    --variable=gdk_pixbuf_binarydir)
      echo "''${SYNCPEER_APPIMAGE_GDK_STAGE_DIR:-/usr}/lib/gdk-pixbuf-2.0/2.10.0"
      exit 0
      ;;
    --variable=gdk_pixbuf_cache_file)
      echo "''${SYNCPEER_APPIMAGE_GDK_STAGE_DIR:-/usr}/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"
      exit 0
      ;;
    --variable=gdk_pixbuf_moduledir)
      echo "''${SYNCPEER_APPIMAGE_GDK_STAGE_DIR:-/usr}/lib/gdk-pixbuf-2.0/2.10.0/loaders"
      exit 0
      ;;
  esac
fi
exec ${pkgs.pkgconf}/bin/pkgconf "''$@"
EOF
          chmod +x "$shim_dir/pkgconf"
          ln -sf "$shim_dir/pkgconf" "$shim_dir/pkg-config"
          ${appimageFhs}/bin/syncpeer-appimage-fhs -lc "cd \"$repo_root\" && PATH=\"$shim_dir:\$PATH\" HOME=\"$home_dir\" RUSTUP_HOME=\"$rustup_home\" CARGO_HOME=\"$cargo_home\" CARGO_TARGET_DIR=\"$cargo_target_dir\" TMPDIR=\"$tmp_dir\" XDG_CACHE_HOME=\"$cache_dir\" SYNCPEER_APPIMAGE_SCHEMAS_DIR=\"$schemas_dir\" SYNCPEER_APPIMAGE_GTK_STAGE_DIR=\"$gtk_stage_dir\" SYNCPEER_APPIMAGE_GDK_STAGE_DIR=\"$gdk_stage_dir\" XDG_DATA_DIRS=\"/usr/share:${pkgs.gsettings-desktop-schemas}/share:${pkgs.gtk3}/share:${pkgs.adwaita-icon-theme}/share\" WINIT_WAYLAND_CSD_THEME=light LIBDECOR_PLUGIN_DIR=\"${pkgs.libdecor}/lib/libdecor/plugins-1\" RUST_BACKTRACE=1 APPIMAGE_EXTRACT_AND_RUN=1 /bin/bash -lc 'set -euo pipefail; echo \"[appimage-debug] id=\$(id -u):\$(id -g) user=\$(id -un) group=\$(id -gn)\"; echo \"[appimage-debug] run_id=$run_id\"; echo \"[appimage-debug] HOME=\$HOME\"; echo \"[appimage-debug] TMPDIR=\$TMPDIR\"; echo \"[appimage-debug] XDG_CACHE_HOME=\$XDG_CACHE_HOME\"; echo \"[appimage-debug] CARGO_TARGET_DIR=\$CARGO_TARGET_DIR\"; echo \"[appimage-debug] PATH=\$PATH\"; echo \"[appimage-debug] cargo=\$(command -v cargo || true)\"; echo \"[appimage-debug] rustc=\$(command -v rustc || true)\"; echo \"[appimage-debug] WINIT_WAYLAND_CSD_THEME=\$WINIT_WAYLAND_CSD_THEME\"; echo \"[appimage-debug] LIBDECOR_PLUGIN_DIR=\$LIBDECOR_PLUGIN_DIR\"; gdk_cache=\"/tmp/syncpeer-appimage-gdk-pixbuf-loaders.cache\"; ${pkgs.gdk-pixbuf}/bin/gdk-pixbuf-query-loaders ${pkgs.gdk-pixbuf}/lib/gdk-pixbuf-2.0/2.10.0/loaders/*.so ${pkgs.librsvg}/lib/gdk-pixbuf-2.0/2.10.0/loaders/*.so > \"\$gdk_cache\" 2>/dev/null || true; if [ -s \"\$gdk_cache\" ]; then export GDK_PIXBUF_MODULE_FILE=\"\$gdk_cache\"; fi; mkdir -p \"\$CARGO_TARGET_DIR\" \"\$TMPDIR\" \"\$XDG_CACHE_HOME\"; ls -ld \"\$CARGO_TARGET_DIR\" \"\$TMPDIR\" \"\$XDG_CACHE_HOME\" \"\$HOME\"; stat -c \"[appimage-debug] %A %a %u:%g %n\" \"\$CARGO_TARGET_DIR\" \"\$TMPDIR\" \"\$XDG_CACHE_HOME\" \"\$HOME\"; npm run build:bundle:appimage -w @syncpeer/tauri-shell -- --verbose'"
          artifact="$(find "$cargo_target_dir/release/bundle/appimage" -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
          test -n "$artifact"
          output_dir="$repo_root/packages/tauri-shell/src-tauri/target/release/bundle/appimage"
          dist_dir="$repo_root/dist"
          mkdir -p "$output_dir"
          mkdir -p "$dist_dir"
          cp "$artifact" "$output_dir/"
          cp "$artifact" "$dist_dir/"
        '';
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs

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
            gsettings-desktop-schemas
            adwaita-icon-theme
            hicolor-icon-theme
            dconf
            cairo
            pango
            gdk-pixbuf
            librsvg
            atk
            libdecor
            mesa
            xdg-utils
            xvfb-run

            jdk
            androidSdk

            gradle
          ];

          ANDROID_HOME = androidSdkRoot;
          ANDROID_SDK_ROOT = androidSdkRoot;
          NDK_HOME = "${androidSdkRoot}/ndk/${android.ndkVersion}";
          JAVA_HOME = "${jdk}";
          RUST_BACKTRACE = "1";
          __EGL_VENDOR_LIBRARY_FILENAMES = "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json";
          LIBGL_DRIVERS_PATH = "${pkgs.mesa}/lib/dri";
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (with pkgs; [
            gtk3
            webkitgtk_4_1
            libsoup_3
            glib
            cairo
            pango
            gdk-pixbuf
            atk
            mesa
          ]);
          shellHook = ''
            export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
            export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share:${pkgs.gtk3}/share:${pkgs.glib}/share:${pkgs.adwaita-icon-theme}/share:${pkgs.hicolor-icon-theme}/share:''${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
            export WINIT_WAYLAND_CSD_THEME=light
            export LIBDECOR_PLUGIN_DIR="${pkgs.libdecor}/lib/libdecor/plugins-1"
            if [ ! -e /run/opengl-driver/lib/gbm/dri_gbm.so ] || [ -n "''${WAYLAND_DISPLAY:-}" ] || [ "''${XDG_SESSION_TYPE:-}" = "wayland" ]; then
              export WEBKIT_DISABLE_DMABUF_RENDERER="1"
              export LIBGL_ALWAYS_SOFTWARE=1
              export GALLIUM_DRIVER=llvmpipe
            fi
            gdk_cache="/tmp/syncpeer-gdk-pixbuf-loaders.cache"
            ${pkgs.gdk-pixbuf}/bin/gdk-pixbuf-query-loaders \
              ${pkgs.gdk-pixbuf}/lib/gdk-pixbuf-2.0/2.10.0/loaders/*.so \
              ${pkgs.librsvg}/lib/gdk-pixbuf-2.0/2.10.0/loaders/*.so \
              > "$gdk_cache" 2>/dev/null || true
            if [ -s "$gdk_cache" ]; then
              export GDK_PIXBUF_MODULE_FILE="$gdk_cache"
            fi
            gtk_schema_dir="$(echo ${pkgs.gtk3}/share/gsettings-schemas/*/glib-2.0/schemas | head -n1)"
            if [ -d "$gtk_schema_dir" ] && [ -f "$gtk_schema_dir/gschemas.compiled" ]; then
              export GSETTINGS_SCHEMA_DIR="$gtk_schema_dir"
            else
              unset GSETTINGS_SCHEMA_DIR
            fi

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
