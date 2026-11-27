import sharp from 'sharp'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url))

// ------------------------------------------------------------
// FONT
// Cover brat memakai Arial Narrow (Regular). Modul ini membaca
// file fontnya langsung, jadi tidak bergantung pada font sistem.
// Urutan pencarian:
//   1. Variabel env BRAT_FONT (+ BRAT_FONT_FAMILY, opsional)
//   2. ./fonts/ARIALN.TTF  (di samping file ini)
//   3. Lokasi bawaan Windows / macOS
//   4. Liberation Sans Narrow (ukurannya identik dengan Arial Narrow)
// ------------------------------------------------------------

const FONT_CANDIDATES = [
    process.env.BRAT_FONT && {
        file: process.env.BRAT_FONT,
        family: process.env.BRAT_FONT_FAMILY || 'Arial Narrow'
    },
    { file: path.join(BASE_DIR, 'fonts', 'ARIALN.TTF'), family: 'Arial Narrow' },
    { file: path.join(BASE_DIR, 'fonts', 'arialn.ttf'), family: 'Arial Narrow' },
    { file: 'C:\\Windows\\Fonts\\ARIALN.TTF', family: 'Arial Narrow' },
    { file: '/System/Library/Fonts/Supplemental/Arial Narrow.ttf', family: 'Arial Narrow' },
    { file: '/Library/Fonts/Arial Narrow.ttf', family: 'Arial Narrow' },
    {
        file: '/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Regular.ttf',
        family: 'Liberation Sans Narrow'
    }
].filter(Boolean)

let fontPromise

function getFont() {
    if (!fontPromise) {
        fontPromise = (async () => {
            for (const candidate of FONT_CANDIDATES) {
                try {
                    await fs.access(candidate.file)
                    return candidate
                } catch { /* coba kandidat berikutnya */ }
            }

            throw new Error(
                'Font Arial Narrow tidak ditemukan. Salin ARIALN.TTF ke folder "fonts" di samping bratSticker.js.'
            )
        })()
    }

    return fontPromise
}

// ------------------------------------------------------------
// Pengaturan tampilan (disamakan dengan cover brat)
// ------------------------------------------------------------

// bw = teks hitam di latar putih, wb = teks putih di latar hitam
const THEMES = {
    bw: { background: '#FFFFFF', color: '#000000' },
    wb: { background: '#000000', color: '#FFFFFF' }
}

const SIZE = 512
const PAD_X = 16             // margin kiri dan kanan
const PAD_TOP = 20           // margin atas (sampai puncak huruf tinggi)
const PAD_BOTTOM = 8         // margin bawah (sampai ekor huruf)
const LINE_HEIGHT = 0.98     // jarak antar baris (x ukuran font)
const MIN_GAP = 0.25         // jarak minimum antar kata (x ukuran font)
const MAX_FONT = 280         // batas ukuran font untuk teks yang sangat pendek
const MIN_FONT = 14
const REF_SIZE = 100         // ukuran acuan untuk perkiraan awal
const MAX_WORDS_VIDEO = 30
const BLUR_SIGMA = 3       // tingkat blur teks (0 = mati, 1-2 = tipis, 3+ = tebal)
const WORD_DELAY_MS = 600    // durasi tiap kata muncul (ms), sama untuk semua kata 

function getTheme(mode) {
    return THEMES[mode] || THEMES.bw
}

function escapeMarkup(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function toWords(text) {
    return text
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(word => word.slice(0, 30))
}

// ------------------------------------------------------------
// Render kata
// Di akhir tiap kata ditambahkan huruf "bdfhklgjpqy" yang
// transparan. Hasilnya, semua kata punya tinggi gambar yang sama
// sehingga baseline antar kata di satu baris selalu lurus.
// ------------------------------------------------------------

const GUARD = '<span alpha="1">bdfhklgjpqy</span>'

async function renderWord(word, size, color) {
    const font = await getFont()

    const { data, info } = await sharp({
        text: {
            text: `<span foreground="${color}">${escapeMarkup(word)}</span>${GUARD}`,
            font: `${font.family} ${size}`,
            fontfile: font.file,
            dpi: 72,
            rgba: true
        }
    })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })

    // Cari batas tinta (abaikan huruf transparan).
    const { width, height } = info
    let inkLeft = width
    let inkRight = -1

    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            if (data[(y * width + x) * 4 + 3] > 8) {
                if (x < inkLeft) inkLeft = x
                if (x > inkRight) inkRight = x
                break
            }
        }
    }

    return {
        data,
        width,
        height,
        inkLeft: Math.max(inkLeft, 0),
        inkWidth: Math.max(inkRight - inkLeft + 1, 1)
    }
}

const measureCache = new Map()

async function measureWord(word, size) {
    const key = `${size}|${word}`

    if (!measureCache.has(key)) {
        const { height, inkWidth } = await renderWord(word, size, '#000000')
        measureCache.set(key, { width: inkWidth, height })
    }

    return measureCache.get(key)
}

// ------------------------------------------------------------
// Tata letak
// ------------------------------------------------------------

function wrapLines(words, widthOf, size) {
    const maxWidth = SIZE - PAD_X * 2
    const minGap = MIN_GAP * size
    const lines = []
    let line = []
    let lineWidth = 0

    for (const item of words) {
        const w = widthOf(item)

        if (w > maxWidth) return null    // satu kata saja sudah tidak muat

        const nextWidth = line.length ? lineWidth + minGap + w : w

        if (nextWidth > maxWidth && line.length) {
            lines.push(line)
            line = [item]
            lineWidth = w
        } else {
            line.push(item)
            lineWidth = nextWidth
        }
    }

    if (line.length) lines.push(line)

    return lines
}

function fitsHeight(lineCount, size, imageHeight) {
    const used = (lineCount - 1) * size * LINE_HEIGHT + imageHeight
    return used <= SIZE - PAD_TOP - PAD_BOTTOM
}

// Cari ukuran font terbesar yang muat, lalu pastikan dengan
// pengukuran asli pada ukuran tersebut.
async function layoutText(words) {
    const ref = await Promise.all(words.map(word => measureWord(word, REF_SIZE)))
    const refHeight = ref[0].height

    const items = words.map((word, i) => ({ word, refWidth: ref[i].width }))

    // 1. Perkiraan cepat dari ukuran acuan (skala linear).
    let start = MIN_FONT

    for (let size = MAX_FONT; size >= MIN_FONT; size--) {
        const lines = wrapLines(
            items,
            item => (item.refWidth * size) / REF_SIZE,
            size
        )

        if (lines && fitsHeight(lines.length, size, (refHeight * size) / REF_SIZE)) {
            start = size
            break
        }
    }

    // 2. Pengukuran asli pada ukuran terpilih (turun jika ternyata tidak muat).
    for (let size = start; size >= MIN_FONT; size--) {
        const real = await Promise.all(words.map(word => measureWord(word, size)))
        const realItems = words.map((word, i) => ({ word, width: real[i].width }))
        const lines = wrapLines(realItems, item => item.width, size)

        if (lines && fitsHeight(lines.length, size, real[0].height)) {
            return { size, lines }
        }
    }

    const real = await Promise.all(words.map(word => measureWord(word, MIN_FONT)))
    const realItems = words.map((word, i) => ({ word, width: real[i].width }))

    return {
        size: MIN_FONT,
        lines: wrapLines(realItems, item => item.width, MIN_FONT) || [realItems]
    }
}

// ------------------------------------------------------------
// Menggambar satu frame
// ------------------------------------------------------------

async function renderFrame(words, mode) {
    const { background, color } = getTheme(mode)
    const { size, lines } = await layoutText(words)
    const maxWidth = SIZE - PAD_X * 2
    const pitch = size * LINE_HEIGHT

    const composites = []

    for (let row = 0; row < lines.length; row++) {
        const line = lines[row]

        const rendered = await Promise.all(
            line.map(item => renderWord(item.word, size, color))
        )

        const totalInk = rendered.reduce((sum, r) => sum + r.inkWidth, 0)

        // Baris dengan 2+ kata dibuat rata kiri-kanan, 1 kata rata kiri.
        const gap = line.length > 1
            ? Math.max((maxWidth - totalInk) / (line.length - 1), 0)
            : 0

        let cursor = PAD_X
        const top = Math.round(PAD_TOP + row * pitch)

        for (const r of rendered) {
            const input = await sharp(r.data, {
                raw: { width: r.width, height: r.height, channels: 4 }
            })
                .extract({
                    left: r.inkLeft,
                    top: 0,
                    width: Math.min(r.inkWidth, r.width - r.inkLeft),
                    height: r.height
                })
                .png()
                .toBuffer()

            composites.push({ input, left: Math.round(cursor), top })

            cursor += r.inkWidth + gap
        }
    }

    // Gabungkan dulu, lalu blur seluruh frame (latar polos tidak terpengaruh).
    const base = await sharp({
        create: {
            width: SIZE,
            height: SIZE,
            channels: 4,
            background
        }
    })
        .composite(composites)
        .png()
        .toBuffer()

    const frame = sharp(base)

    return BLUR_SIGMA > 0 ? frame.blur(BLUR_SIGMA) : frame
}

// ------------------------------------------------------------
// Stiker gambar (WebP statis 512x512)
// ------------------------------------------------------------

export async function createBratSticker(text, mode = 'bw') {
    const words = toWords(text)

    if (!words.length) throw new Error('Teks kosong.')

    const frame = await renderFrame(words, mode)

    return frame.webp({ quality: 90, effort: 5 }).toBuffer()
}

// ------------------------------------------------------------
// Stiker video (WebP animasi)
// Kata muncul satu per satu. Awalnya besar, lalu font mengecil
// menyesuaikan jumlah kata yang tampil. Tiap kata tampil
// selama WORD_DELAY_MS, termasuk kata terakhir.
// ------------------------------------------------------------

export async function createBratVidSticker(text, mode = 'bw') {
    const words = toWords(text).slice(0, MAX_WORDS_VIDEO)

    if (!words.length) throw new Error('Teks kosong.')

    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'mettugi-bratvid-')
    )

    try {
        for (let i = 1; i <= words.length; i++) {
            const frame = await renderFrame(words.slice(0, i), mode)
            const name = `frame_${String(i - 1).padStart(4, '0')}.png`

            await frame.png().toFile(path.join(directory, name))
        }

        const outputPath = path.join(directory, 'sticker.webp')

        await execFileAsync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-framerate', String(1000 / WORD_DELAY_MS),
            '-i', path.join(directory, 'frame_%04d.png'),
            '-vf', 'scale=512:512,format=yuva420p',
            '-c:v', 'libwebp_anim',
            '-loop', '0',
            '-quality', '50',
            '-compression_level', '6',
            outputPath
        ], {
            timeout: 120000,
            maxBuffer: 10 * 1024 * 1024
        })

        const sticker = await fs.readFile(outputPath)

        if (sticker.length > 500 * 1024) {
            throw new Error('Ukuran stiker animasi melebihi 500 KB. Coba teks yang lebih pendek.')
        }

        return sticker

    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
}
