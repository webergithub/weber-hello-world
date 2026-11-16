#!/bin/sh
# 把相册网页复制进 ipad/web，随应用一起打包。 Copies the album site into ipad/web so it ships inside the app.
set -e
cd "$(dirname "$0")"
rm -rf web && mkdir web
for f in index.html manage.html login.html manifest.webmanifest css js fonts album icons; do cp -R "../$f" web/; done
[ -d ../vendor ] && cp -R ../vendor web/ || true
echo "web/ ready"
