# vscode-markdown-editor

Форк `zaaack/vscode-markdown-editor` для личного использования, расширение стоит в Cursor пользователя вместо оригинала.

## После любых изменений

Сразу, без отдельной просьбы, пушить в `main` и заменять расширение в Cursor. Изменение не считается сделанным, пока оно не в `main` на GitHub и не установлено в Cursor.

1. Собрать: `pnpm run build`.
2. Закоммитить в `main` (формат сообщения — в `.cursorrules`) и запушить: `git push origin main`.
3. Собрать `.vsix`: `rm -f *.vsix && pnpm dlx @vscode/vsce package --no-dependencies --allow-missing-repository`.
4. Заменить расширение в Cursor: `cursor --install-extension "$PWD/markdown-editor-0.1.21.vsix" --force` (имя файла берётся из версии в `package.json`).
5. Сказать пользователю выполнить в Cursor `Developer: Reload Window` — без перезагрузки окна работает старая версия.
