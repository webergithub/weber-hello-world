/* 相册包 Album file
   在 manage.html 里导入照片后点"导出相册包"，用下载到的 album.js 替换这个文件，
   这样换一台设备（比如电视）打开网站也能看到照片。
   留着 null 表示没有相册包：网站会用本浏览器里保存的照片，或 album/0.jpg … album/10.jpg。 */
window.TENUP_ALBUM = null;
