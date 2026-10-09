# SPDX-License-Identifier: GPL-3.0-or-later
{
  description = "Development environment for opencode-hermes-bridge";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }: {
    devShells.x86_64-linux.default =
      let
        pkgs = import nixpkgs { system = "x86_64-linux"; };
      in
      pkgs.mkShell {
        packages = with pkgs; [ bun nodejs python3 ];
      };
  };
}
