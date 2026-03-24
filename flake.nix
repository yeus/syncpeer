{
  description = "Development environment for the Syncpeer monorepo";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };
    in {
      devShells.default = pkgs.mkShell {
        buildInputs = [
          pkgs.nodejs
          pkgs.yarn
          pkgs.rustc
          pkgs.cargo
          pkgs.pkg-config
          pkgs.openssl
          pkgs.gtk3
          pkgs.webkitgtk_4_1
          pkgs.libsoup_3
          pkgs.glib
          pkgs.cairo
          pkgs.pango
          pkgs.gdk-pixbuf
          pkgs.atk
        ];
        RUST_BACKTRACE = "1";
        shellHook = ''
          echo "Welcome to the Syncpeer development shell.";
          echo "Rust, Node.js and OpenSSL are available.";
        '';
      };
    });
}
