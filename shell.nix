{
  pkgs ? import <nixpkgs> { },
}:

pkgs.mkShell {
  buildInputs = with pkgs; [
    bun
    nodejs_22
    typescript
    just
  ];

  shellHook = ''
    echo "opencode-auto-continue dev shell"
    echo "  bun $(bun --version)"
    echo "  node $(node --version)"
    echo "  tsc $(tsc --version)"
    echo "  just $(just --version)"
    echo ""
    echo "Run 'just' to see available commands."
  '';
}
