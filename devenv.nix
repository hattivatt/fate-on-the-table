{ pkgs, ... }:

{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    npm = {
      enable = true;
      install.enable = true;
    };
  };

  packages = with pkgs; [
    git
    jq
    zip
    ripgrep
    fd
    watchexec

    typescript-language-server # для neovim LSP
    typescript
  ];
}
