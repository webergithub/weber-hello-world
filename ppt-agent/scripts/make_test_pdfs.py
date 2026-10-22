#!/usr/bin/env python3
"""生成 PDF 测试数据：test-ppts/PDF文档/（reportlab 文本 PDF + LibreOffice 把一份 PPT 导出为 PDF）。"""
import os, shutil, subprocess, sys, tempfile
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

root = sys.argv[1] if len(sys.argv) > 1 else 'test-ppts'
out = os.path.join(root, 'PDF文档')
os.makedirs(out, exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))

PAGES = [
    ('机场行李处理系统运维手册', ['适用范围：T1/T2 航站楼行李分拣系统（BHS）', '编制部门：机场运行保障部', '版本：2026 版']),
    ('一、系统组成', ['值机岛输送线与安检联动', '高速分拣机：倾翻盘式，额定 6000 件/小时', '早到行李存储系统（EBS）', 'RFID 行李标签读写站']),
    ('二、日常巡检', ['每班开工前检查急停按钮与光电开关', '分拣机托盘异响需立即上报', '巡检记录写入运维平台，保留 3 年']),
    ('三、故障处置', ['卡包：按停机 → 挂牌 → 清理 → 复位流程', '误分拣率高于 0.5% 时启动人工复核', '联系电话：运行指挥中心 AOC']),
]

c = canvas.Canvas(os.path.join(out, '行李系统运维手册.pdf'), pagesize=A4)
c.setTitle('机场行李处理系统运维手册')
c.setAuthor('运行保障部')
w, h = A4
for title, lines in PAGES:
    c.setFont('STSong-Light', 22)
    c.drawString(60, h - 90, title)
    c.setFont('STSong-Light', 13)
    y = h - 140
    for l in lines:
        c.drawString(72, y, l)
        y -= 26
    c.setFont('STSong-Light', 9)
    c.drawString(w / 2 - 10, 30, str(PAGES.index((title, lines)) + 1))
    c.showPage()
c.save()

# 一份 PPT 导出的 PDF（含黑底页面）
src = os.path.join(root, '机场运营', '航班过站保障Turnaround_黑底.pptx')
if shutil.which('soffice') and os.path.exists(src):
    tmp = tempfile.mkdtemp()
    subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', tmp, src], check=True, capture_output=True, timeout=180)
    shutil.copy(os.path.join(tmp, '航班过站保障Turnaround_黑底.pdf'), os.path.join(out, '航班过站保障Turnaround_黑底.pdf'))
    shutil.rmtree(tmp, ignore_errors=True)
print('ok', os.listdir(out))
