{
  description = "syncpeer - lightweight Syncthing BEP CLI client";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };

        nodejs = pkgs.nodejs_22;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs
            jq
            openssl
            protobuf
            nixpkgs-fmt
            curl
            gnutar
          ];

          shellHook = ''
            echo "syncpeer dev shell"
            echo "node: $(node --version)"
            echo "npm: $(npm --version)"
          '';
        };

        formatter = pkgs.nixpkgs-fmt;
      }
    );
}
