{
  description = "Version checker";

  outputs = { self, nixpkgs }:
    let
      supportedPlatforms = [ "x86_64-linux" "aarch64-darwin" ];
      inherit (nixpkgs) lib;
    in {
      devShells = lib.genAttrs supportedPlatforms (system: {
        default = with nixpkgs.legacyPackages."${system}"; mkShell {
          packages = [ deno sqlite ];
        };
      });

      packages = lib.genAttrs supportedPlatforms (system: {
        default =
          with nixpkgs.legacyPackages."${system}";
          runCommand "versioncheck" {
            nativeBuildInputs = [ makeWrapper ];
          } ''
            mkdir $out $out/{bin,lib}
            cp -vr ${./src}/*        $out/lib/
            cp -v  ${./versioncheck} $out/bin/versioncheck

            substituteInPlace $out/bin/versioncheck \
              --replace "src/index.ts" "$out/lib/index.ts"

            wrapProgram $out/bin/versioncheck --prefix PATH : ${lib.makeBinPath [ deno ]}
          '';
      });
    };
}
