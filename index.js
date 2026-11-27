import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    downloadMediaMessage,
    generateWAMessageFromContent,
    proto
} from '@whiskeysockets/baileys'

import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import sharp from 'sharp'
import { createBratSticker, createBratVidSticker } from './bratSticker.js'
import { sendSoundSticker } from './soundSticker.js'
import { convertSticker, findSticker, enableSoundStickerDecode } from './stickerConvert.js'

import pino from 'pino'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const silentLogger = pino({ level: 'silent' })
const MAX_MEDIA_SIZE = 50 * 1024 * 1024
const MAX_WHATSAPP_DOCUMENT_SIZE = 2 * 1024 * 1024 * 1024
const MAX_WHATSAPP_VIDEO_SIZE = 64 * 1024 * 1024
const GREETINGS = ['pagi', 'siang', 'sore', 'malam']
// DAFTAR GRUP YANG DIIZINKAN
const ALLOWED_GROUPS = [
    `120363432959953036@g.us`,
    `6282296328396-1594959362@g.us`,
    `120363173864417994@g.us`,
    `6282296328396-1597933414@g.us`,
    `120363044867193338@g.us`,
    `120363021329194287@g.us`,
    `6287759708066-1628406173@g.us`,
    `120363028321460419@g.us`,
    `120363025876861269@g.us`,
    `120363024669557177@g.us`

]

function unwrapMessage(message) {
    let content = message?.message

    while (
        content?.ephemeralMessage?.message ||
        content?.viewOnceMessage?.message ||
        content?.viewOnceMessageV2?.message ||
        content?.documentWithCaptionMessage?.message
    ) {
        content =
            content.ephemeralMessage?.message ||
            content.viewOnceMessage?.message ||
            content.viewOnceMessageV2?.message ||
            content.documentWithCaptionMessage?.message
    }

    return content || {}
}

function getQuotedMessage(message, jid) {
    const content = unwrapMessage(message)

    const context =
        content.extendedTextMessage?.contextInfo ||
        content.imageMessage?.contextInfo ||
        content.videoMessage?.contextInfo ||
        content.audioMessage?.contextInfo

    if (!context?.quotedMessage) return null

    return {
        key: {
            remoteJid: jid,
            id: context.stanzaId,
            participant: context.participant,
            fromMe: false
        },
        message: context.quotedMessage
    }
}

function getMediaKind(message) {
    const content = unwrapMessage(message)

    if (content.imageMessage) return 'image'
    if (content.audioMessage) return 'audio'
    if (content.videoMessage) return 'video'
    if (content.documentMessage) return 'document'
    if (content.stickerMessage) return 'sticker'

    return null
}

// Sumber stiker untuk .s: gambar, video, atau DOKUMEN (GIF, gambar, video).
// GIF yang dikirim sebagai foto/video diubah WhatsApp menjadi MP4 tanpa
// transparansi (latar jadi hitam); sebagai dokumen, file aslinya utuh.
// Mengembalikan { kind: 'image' | 'video', ext } atau null.
function getStickerSource(message) {
    const content = unwrapMessage(message)

    if (content.imageMessage) return { kind: 'image', ext: 'img' }
    if (content.videoMessage) return { kind: 'video', ext: 'mp4' }

    const doc = content.documentMessage

    if (doc) {
        const mime = (doc.mimetype || '').toLowerCase()
        const name = (doc.fileName || '').toLowerCase()

        if (mime === 'image/gif' || name.endsWith('.gif')) {
            return { kind: 'video', ext: 'gif' }
        }

        if (mime.startsWith('video/')) return { kind: 'video', ext: 'mp4' }
        if (mime.startsWith('image/')) return { kind: 'image', ext: 'img' }
    }

    return null
}

async function downloadIncomingMedia(sock, message) {
    return downloadMediaMessage(message, 'buffer', {}, {
        logger: silentLogger,
        reuploadRequest: sock.updateMediaMessage
    })
}

async function runFfmpeg(args) {
    await execFileAsync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-y', ...args],
        {
            timeout: 120000,
            maxBuffer: 10 * 1024 * 1024
        }
    )
}

// Video biasa -> "GIF" WhatsApp (MP4 tanpa suara yang dikirim dengan
// gifPlayback). Dibatasi 10 detik, lebar maks 480 px, agar ringan.
async function convertVideoToGif(videoBuffer) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mettugi-togif-'))

    try {
        const input = path.join(directory, 'input')
        const output = path.join(directory, 'out.mp4')

        await fs.writeFile(input, videoBuffer)

        await runFfmpeg([
            '-i', input,
            '-t', '10',
            '-an',
            '-vf', "fps=20,scale='min(480,iw)':-2,format=yuv420p",
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '26',
            '-movflags', '+faststart',
            output
        ])

        const buffer = await fs.readFile(output)

        if (!buffer.length) throw new Error('Hasil konversi kosong.')

        return buffer
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
}

// ==========================================
// RATE
// ==========================================
// .rate [pesan]?  -> 3 balasan: teks rate, emoji, dan (hanya 100%) stiker
// dari assets/wah.gif.

const ASSET_DIR = fileURLToPath(new URL('./assets/', import.meta.url))
const RATE_STICKER_GIF = path.join(ASSET_DIR, 'wah.gif')
const gifStickerCache = new Map()

function rateEmoji(rate) {
    if (rate === 0) return '🤮'
    if (rate <= 20) return '😧'
    if (rate <= 40) return '😐'
    if (rate <= 60) return '😮'
    if (rate <= 80) return '😃'
    if (rate < 100) return '🥰'

    return '😍'
}

// GIF -> stiker animasi WebP (10 detik pertama, transparansi dipertahankan).
// Hasilnya disimpan di memori per file karena filenya tetap.
async function getGifSticker(gifPath) {
    if (gifStickerCache.has(gifPath)) return gifStickerCache.get(gifPath)

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mettugi-rate-'))

    try {
        const outputPath = path.join(directory, 'sticker.webp')

        const encode = async (fps, quality) => {
            await runFfmpeg([
                '-i', gifPath,
                '-t', '10',
                '-vf', `fps=${fps},format=rgba,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p`,
                '-an',
                '-c:v', 'libwebp_anim',
                '-loop', '0',
                '-quality', String(quality),
                '-compression_level', '6',
                '-preset', 'default',
                outputPath
            ])

            return fs.readFile(outputPath)
        }

        let sticker = await encode(12, 40)

        // Batas stiker animasi WhatsApp 500 KB: coba lagi lebih ringan.
        if (sticker.length > 500 * 1024) sticker = await encode(8, 25)

        gifStickerCache.set(gifPath, sticker)

        return sticker
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
}

function getRateSticker() {
    return getGifSticker(RATE_STICKER_GIF)
}

// ==========================================
// HUSBU / WAIFU
// ==========================================
// Semua gambar (PNG, JPG, JPEG) di assets/husbu dan assets/waifu dibaca
// otomatis saat perintah dipakai, jadi menambah/menghapus gambar tidak perlu
// mengubah kode.
// Nama karakter = nama file tanpa ekstensi (.png / .jpg / .jpeg).

const PAIR_FOLDERS = {
    husbu: path.join(ASSET_DIR, 'husbu'),
    waifu: path.join(ASSET_DIR, 'waifu')
}

// Ekstensi gambar yang didukung untuk husbu/waifu.
const PAIR_IMAGE_REGEX = /\.(png|jpe?g)$/i

// Respons spesial: ikut masuk undian dengan peluang SAMA seperti satu file
// gambar biasa. Tiap entri punya:
//   name     : nama internal (tidak ditampilkan)
//   messages : pesan teks yang dikirim berurutan (yang pertama me-reply perintah)
//   sticker  : (opsional) GIF yang dikirim sebagai stiker animasi setelah teks
// Tambah entri baru di sini untuk respons spesial lain.
const JOMBLO_SPECIAL = {
    name: 'jomblo',
    messages: [
        'Pasangan kamu hari ini adalah....',
        'Kamu nungguin apa? Jomblo mah jomblo aja'
    ],
    sticker: path.join(ASSET_DIR, 'jomblo.gif')
}

const PAIR_SPECIALS = {
    husbu: [JOMBLO_SPECIAL],
    waifu: [JOMBLO_SPECIAL]
}

// Batas roll per user per sesi 12 jam, dihitung terpisah untuk husbu dan waifu.
// Sesi mengikuti WIB: 00.00-11.59 dan 12.00-23.59. Hitungan reset saat sesi
// berganti. Data disimpan di file agar tidak ter-reset saat bot restart.
const PAIR_ROLL_LIMIT = 10
const PAIR_LIMIT_TIMEZONE = 'Asia/Jakarta'
const PAIR_LIMIT_FILE = fileURLToPath(new URL('./husbu_waifu_rolls.json', import.meta.url))
const PAIR_LIMIT_MESSAGE = '🚫Jangan roll lagi! Pacarmu udah banyak, emang ga cukup?'

let pairRollData = null // { session: 'YYYY-MM-DD#0|1', users: { [jid]: { husbu, waifu } } }
let pairRollSaveChain = Promise.resolve()

// Penanda sesi 12 jam saat ini, mis. "2026-11-27#0" (pagi) atau "2026-11-27#1" (siang-malam).
function pairSession() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: PAIR_LIMIT_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date())

    const get = type => parts.find(part => part.type === type).value

    return `${get('year')}-${get('month')}-${get('day')}#${Number(get('hour')) < 12 ? 0 : 1}`
}

async function loadPairRollData() {
    if (!pairRollData) {
        try {
            pairRollData = JSON.parse(await fs.readFile(PAIR_LIMIT_FILE, 'utf8'))
        } catch {
            pairRollData = null
        }
    }

    // Sesi berganti (atau file lama/tidak ada) -> semua hitungan mulai dari nol.
    if (!pairRollData || pairRollData.session !== pairSession()) {
        pairRollData = { session: pairSession(), users: {} }
    }

    return pairRollData
}

function savePairRollData() {
    const snapshot = JSON.stringify(pairRollData)

    pairRollSaveChain = pairRollSaveChain
        .then(() => fs.writeFile(PAIR_LIMIT_FILE, snapshot))
        .catch(error => console.error('Gagal menyimpan batas roll husbu/waifu:', error.message))
}

// Pakai satu jatah roll untuk kind ('husbu' / 'waifu'). false = jatah habis.
async function reservePairRoll(userId, kind) {
    const data = await loadPairRollData()
    const counts = data.users[userId] || (data.users[userId] = { husbu: 0, waifu: 0 })

    if ((counts[kind] || 0) >= PAIR_ROLL_LIMIT) return false

    counts[kind] = (counts[kind] || 0) + 1
    savePairRollData()

    return true
}

// Kembalikan jatah kalau roll gagal diproses (bukan salah user).
async function refundPairRoll(userId, kind) {
    const data = await loadPairRollData()
    const counts = data.users[userId]

    if (counts && counts[kind] > 0) {
        counts[kind] -= 1
        savePairRollData()
    }
}

// PNG/JPG/JPEG -> stiker WebP 512x512 (transparansi PNG dipertahankan;
// area kosong di sekitar JPG juga dibuat transparan).
function pairFileToSticker(filePath) {
    return sharp(filePath)
        .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .webp({ quality: 90, effort: 5 })
        .toBuffer()
}

async function pickRandomPair(kind) {
    const directory = PAIR_FOLDERS[kind]
    const entries = await fs.readdir(directory, { withFileTypes: true })

    const files = entries
        .filter(entry => entry.isFile() && PAIR_IMAGE_REGEX.test(entry.name))
        .map(entry => entry.name)

    // Gambar biasa dan respons spesial berada di satu undian, jadi
    // setiap entri punya peluang yang sama.
    const pool = [
        ...files.map(file => ({
            name: file.replace(PAIR_IMAGE_REGEX, ''),
            filePath: path.join(directory, file)
        })),
        ...(PAIR_SPECIALS[kind] || []).map(special => ({ special }))
    ]

    if (!pool.length) return null

    return pool[Math.floor(Math.random() * pool.length)]
}

// ==========================================
// WARUNG METTUGI: data menu, tombol, dan stiker menu
// ==========================================
// Gambar menu (PNG transparan) disimpan di folder ./assets/menu_warung
// dengan nama file sesuai menu, mis. "Ikan Rebus".
// Tanda "/" tidak boleh ada di nama file, jadi "Sambal" memakai
// file "Sambal.webp".

const WARUNG_MENU_DIR = path.join(ASSET_DIR, 'menu_warung')

const WARUNG_MENU = [
    {
        header: ' *Menu Original Warung* ',
        categories: [
            {
                title: 'Makanan',
                items: [
                    ['Ikan Rebus', 25],
                    ['Bebek Panggang Byakko', 20],
                    ['Nasi', 10],
                    ['Soto Mugi', 30],
                    ['Sambal', 5],
                    ['Nasi Padang Maha5', 25],
                    ['Tatsumie Sedaap', 20],
                    ['Nasi Kuning', 35]
                ]
            },
            {
                title: 'Minuman',
                items: [
                    ['Es Serut', 10],
                    ['Es Teh', 5],
                    ['Teh Pugi', 5]
                ]
            },
            {
                title: 'Makanan Pelengkap',
                items: [
                    ['Kue Belalang', 20],
                    ['Keju Belatung', 20],
                    ['Kerupuk Head Flip Okhorosho', 10],
                    ['Makaroni Cemcem', 15]
                ]
            }
        ]
    },
    {
        header: 'Menu Club Malam',
        categories: [
            {
                title: null,        // tanpa judul kategori di teks
                label: 'Club Malam',
                items: [
                    ['Bir', 25]
                ]
            }
        ]
    }
]

function warungFileName(name) {
    return `${name.replace(/[\\/]/g, ' ').replace(/\s+/g, ' ').trim()}.webp`
}

function buildWarungText() {
    const lines = ['╭─「 *WARUNG METTUGI* 」']

    for (const group of WARUNG_MENU) {
        lines.push(`╠「${group.header}」`)

        for (const category of group.categories) {
            lines.push('║╭─────')

            if (category.title) lines.push(`║├「${category.title}」`)

            for (const [name, price] of category.items) {
                lines.push(`║│ - ${name} [Harga: ${price} Mettugi]`)
            }

            lines.push('║╰─────')
        }
    }

    lines.push('╰─「Althea」')

    return lines.join('\n')
}

// Kategori menjadi judul section (tidak bisa dipencet), tiap menu
// menjadi baris yang bisa dipilih. Id baris = teks chat yang diproses bot.
// Teks yang diproses bot saat menu dipilih (disimpan di id baris, tidak
// tampil di layar).
function warungOrderText(name) {
    return `Pesan: ${name}`
}

function buildWarungSections() {
    const sections = []

    for (const group of WARUNG_MENU) {
        for (const category of group.categories) {
            sections.push({
                title: category.title || category.label || group.header,
                // Judul = nama menu, harga di baris kecil di bawahnya.
                rows: category.items.map(([name, price]) => ({
                    header: '',
                    title: name,
                    description: `${price} Mettugi`,
                    id: warungOrderText(name)
                }))
            })
        }
    }

    return sections
}

function findWarungItem(input) {
    const clean = (value) => value
        .replace(/\.webp$/i, '')
        .replace(/[\\/]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()

    const wanted = clean(input)

    for (const group of WARUNG_MENU) {
        for (const category of group.categories) {
            for (const [name, price] of category.items) {
                if (clean(name) === wanted) {
                    return { name, price, file: warungFileName(name) }
                }
            }
        }
    }

    return null
}

// Kirim respon warung beserta tombol "Pilih Menu" (native flow single_select).
async function sendWarungMenu(sock, jid, message) {
    const text = buildWarungText()

    try {
        const interactive = proto.Message.InteractiveMessage.create({
            body: proto.Message.InteractiveMessage.Body.create({ text }),
            header: proto.Message.InteractiveMessage.Header.create({
                hasMediaAttachment: false
            }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                buttons: [{
                    name: 'single_select',
                    buttonParamsJson: JSON.stringify({
                        title: 'Pilih Menu',
                        sections: buildWarungSections()
                    })
                }]
            }),
            // Balas (quote) pesan .warung milik pengguna.
            contextInfo: {
                stanzaId: message.key.id,
                participant: message.key.participant || message.key.remoteJid,
                quotedMessage: message.message
            }
        })

        const waMessage = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: interactive
                }
            }
        }, { userJid: sock.user.id })

        await sock.relayMessage(jid, waMessage.message, {
            messageId: waMessage.key.id,
            additionalNodes: [{
                tag: 'biz',
                attrs: {},
                content: [{
                    tag: 'interactive',
                    attrs: { type: 'native_flow', v: '1' },
                    content: [{
                        tag: 'native_flow',
                        attrs: { v: '9', name: 'mixed' }
                    }]
                }]
            }]
        })

    } catch (error) {
        console.error('Gagal mengirim tombol warung, memakai teks biasa:', error)

        await sock.sendMessage(jid, { text }, { quoted: message })
    }
}

// PNG menu -> stiker WebP 512x512 (transparansi dipertahankan).
async function buildWarungSticker(file) {
    const png = await fs.readFile(path.join(WARUNG_MENU_DIR, file))

    return sharp(png)
        .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .webp({ quality: 90, effort: 5 })
        .toBuffer()
}

// Id dari tombol/list yang dipilih pengguna (dianggap sebagai teks chat).
function getButtonReplyId(content) {
    const flow = content?.interactiveResponseMessage?.nativeFlowResponseMessage

    if (flow?.paramsJson) {
        try {
            const id = JSON.parse(flow.paramsJson).id

            if (id) return String(id)
        } catch {
            // abaikan
        }
    }

    return (
        content?.listResponseMessage?.singleSelectReply?.selectedRowId ||
        content?.buttonsResponseMessage?.selectedButtonId ||
        ''
    )
}

function isAllowedDownloadUrl(value, platform) {
    let parsed

    try {
        parsed = new URL(value)
    } catch {
        return false
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) return false

    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')

    const domains = {
        tt: ['tiktok.com'],
        yt: ['youtube.com', 'youtu.be'],
        ig: ['instagram.com'],
        fb: ['facebook.com', 'fb.watch'],
        twt: ['twitter.com', 'x.com', 't.co']
    }

    return domains[platform]?.some(
        domain => host === domain || host.endsWith(`.${domain}`)
    ) || false
}

// File cookies opsional (format Netscape cookies.txt) di folder bot.
// Dibutuhkan untuk Instagram, Facebook, dan X yang sering meminta login,
// serta YouTube bila muncul "Sign in to confirm you're not a bot".
const COOKIES_FILE = path.resolve('cookies.txt')

async function buildYtDlpArgs(platform, outputTemplate, url) {
    const args = [
        '--no-playlist',
        '--no-progress',
        '--no-part',
        '--merge-output-format', 'mp4'
    ]

    if (platform === 'yt') {
        // YouTube sekarang hampir selalu memakai format terpisah (video + audio),
        // jadi "best[ext=mp4]" sering tidak tersedia. Ambil maksimal 720p dan
        // gabungkan dengan FFmpeg.
        args.push('-f', 'bv*[height<=720]+ba/b[height<=720]/b')

        // yt-dlp butuh JavaScript runtime untuk YouTube. Deno dipakai bila ada,
        // dan Node (yang pasti terpasang karena bot ini berjalan di Node)
        // menjadi cadangan.
        args.push('--js-runtimes', 'deno')
        args.push('--js-runtimes', `node:${process.execPath}`)
    } else {
        args.push('-f', 'b[ext=mp4]/bv*+ba/b')
    }

    const hasCookies = await fs.access(COOKIES_FILE).then(
        () => true,
        () => false
    )

    if (hasCookies) {
        args.push('--cookies', COOKIES_FILE)
    }

    args.push('-o', outputTemplate, url)

    return args
}

// Ubah error mentah yt-dlp menjadi pesan yang bisa ditindaklanjuti.
function explainDownloadError(error, platform) {
    if (error.code === 'ENOENT') {
        return 'yt-dlp belum terpasang atau tidak ada di PATH.'
    }

    if (error.killed || error.signal === 'SIGTERM') {
        return 'Unduhan terlalu lama dan dihentikan. Coba lagi atau gunakan video yang lebih pendek.'
    }

    const log = `${error.stderr || ''}\n${error.message || ''}`

    if (/no such option: --js-runtimes/i.test(log)) {
        return 'yt-dlp di PC ini terlalu lama untuk YouTube. Perbarui dengan menjalankan: yt-dlp -U'
    }

    if (/ffmpeg|ffprobe/i.test(log) && /not found|not installed|requires/i.test(log)) {
        return 'FFmpeg tidak ditemukan, padahal dibutuhkan untuk menggabungkan video dan audio.'
    }

    if (platform === 'yt' && /sign in to confirm|not a bot|use --cookies/i.test(log)) {
        return 'YouTube meminta verifikasi login. Simpan cookies YouTube sebagai cookies.txt di folder bot, lalu coba lagi.'
    }

    if (/login required|log in|logged in|rate-limit reached|empty media response|restricted video|private|checkpoint|cookies/i.test(log)) {
        return `Konten ${platform.toUpperCase()} ini membutuhkan login (atau akunnya privat). Simpan cookies akun yang sudah login sebagai cookies.txt di folder bot, lalu coba lagi.`
    }

    if (/no supported javascript runtime|requested format is not available|signature|nsig/i.test(log)) {
        return 'YouTube gagal diproses. Pastikan yt-dlp terbaru (yt-dlp -U) dan Deno terpasang (https://deno.com).'
    }

    if (/unsupported url|no video could be found|no video formats|there is no video/i.test(log)) {
        return 'Tautan ini tidak berisi video yang bisa diunduh. Postingan yang hanya berisi foto atau teks tidak didukung.'
    }

    if (/video unavailable|has been removed|does not exist|not available|404/i.test(log)) {
        return 'Konten tidak ditemukan atau sudah dihapus.'
    }

    return 'Unduhan atau pengiriman gagal. Pastikan tautan dapat diakses dan ukuran file tidak melebihi batas dokumen WhatsApp (2 GB).'
}

async function downloadFromUrl(url, directory, platform) {
    const outputTemplate = path.join(directory, 'media.%(ext)s')

    await execFileAsync(
        'yt-dlp',
        await buildYtDlpArgs(platform, outputTemplate, url),
        {
            // Beri waktu lebih panjang untuk media berukuran besar.
            timeout: 15 * 60 * 1000,
            maxBuffer: 10 * 1024 * 1024
        }
    )

    const files = await fs.readdir(directory)
    const mediaFile = files.find(
        file => file.startsWith('media.') && !file.endsWith('.part')
    )

    if (!mediaFile) {
        throw new Error('Media tidak ditemukan atau tidak didukung.')
    }

    const fullPath = path.join(directory, mediaFile)
    const stat = await fs.stat(fullPath)

    // WhatsApp mengizinkan dokumen hingga 2 GB.
    if (stat.size > MAX_WHATSAPP_DOCUMENT_SIZE) {
        throw new Error('Ukuran media melebihi batas dokumen WhatsApp, yaitu 2 GB.')
    }

    // Kembalikan path, bukan Buffer, agar file besar tidak memenuhi RAM.
    return {
        filePath: fullPath,
        size: stat.size,
        ext: path.extname(mediaFile).toLowerCase()
    }
}

async function startBot() {
    // Agar suara pada stiker bersuara yang DITERIMA tidak dibuang oleh Baileys.
    try {
        enableSoundStickerDecode()
    } catch (error) {
        console.error('Gagal mengaktifkan dukungan suara stiker:', error)
    }

    const { state, saveCreds } =
        await useMultiFileAuthState('./auth_info_baileys')

    const sock = makeWASocket({
        auth: state,
        markOnlineOnConnect: false
    })

    // MENYIMPAN QR CODE SEBAGAI GAMBAR
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            try {
                const qrPath = path.join(process.cwd(), 'qr.png')

                await QRCode.toFile(qrPath, qr, {
                    type: 'png',
                    width: 300,
                    margin: 2,
                    errorCorrectionLevel: 'M'
                })

                console.log('\nQR berhasil disimpan sebagai qr.png')
                console.log('Buka qr.png dan memindainya.\n')
            } catch (error) {
                console.error('Gagal membuat gambar QR:', error)
            }
        }

        if (connection === 'open') {
            console.log('\n================================')
            console.log(' WhatsApp Bot berhasil terhubung!')
            console.log('================================\n')
        }

        if (connection === 'close') {
            const statusCode =
                (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode
                    : undefined

            const shouldReconnect =
                statusCode !== DisconnectReason.loggedOut

            console.log('Koneksi terputus.')

            if (shouldReconnect) {
                console.log('Mencoba menghubungkan kembali...')
                setTimeout(startBot, 3000)
            } else {
                console.log('Sesi logout. Silakan hubungkan ulang.')
            }
        }
    })

    // MENYIMPAN SESI WHATSAPP
    sock.ev.on('creds.update', saveCreds)

    // MEMBACA PESAN MASUK
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const message of messages) {
            if (!message.message || message.key.fromMe) continue

            const jid = message.key.remoteJid

            // BOT HANYA BEKERJA DI GRUP
            if (!jid?.endsWith('@g.us')) continue
            if (!ALLOWED_GROUPS.includes(jid)) continue
            const content = message.message

            const text =
                content.conversation ||
                content.extendedTextMessage?.text ||
                content.imageMessage?.caption ||
                content.videoMessage?.caption ||
                content.audioMessage?.caption ||
                content.documentMessage?.caption ||
                content.documentWithCaptionMessage?.message?.documentMessage?.caption ||
                getButtonReplyId(content) ||
                ''

            const rawCommand = text.trim()
            const command = rawCommand.toLowerCase()

            console.log(`[GRUP] ${jid}: ${text}`)


            // ==========================================
            // STIKER GAMBAR DAN VIDEO ANIMASI
            // ==========================================

            if (/^\.s(?:\s+--crop)?$/i.test(rawCommand)) {
                const quoted = getQuotedMessage(message, jid)

                const target = getStickerSource(message)
                    ? message
                    : quoted

                const source = target ? getStickerSource(target) : null
                const kind = source?.kind

                if (!target || !source) {
                    await sock.sendMessage(jid, {
                        text: 'Kirim gambar atau video dengan caption *.s*, atau balas gambar/video dengan *.s*. GIF transparan: kirim sebagai *dokumen* dengan caption *.s*. Gunakan *.s --crop* untuk memotong menjadi persegi.'
                    }, { quoted: message })

                    continue
                }

                await sock.sendMessage(jid, {
                    text: '⏳Loading....'
                }, { quoted: message })

                const directory = await fs.mkdtemp(
                    path.join(os.tmpdir(), 'mettugi-sticker-')
                )

                try {
                    const crop = /\s--crop$/i.test(rawCommand)
                    const input = await downloadIncomingMedia(sock, target)

                    if (!input?.length) {
                        throw new Error('Media kosong.')
                    }

                    if (input.length > MAX_MEDIA_SIZE) {
                        throw new Error('Ukuran media melebihi 50 MB.')
                    }

                    let sticker

                    if (kind === 'image') {
                        sticker = await sharp(input)
                            .rotate()
                            .resize(512, 512, {
                                fit: crop ? 'cover' : 'contain',
                                background: {
                                    r: 0,
                                    g: 0,
                                    b: 0,
                                    alpha: 0
                                }
                            })
                            .webp({
                                quality: 82,
                                effort: 5
                            })
                            .toBuffer()

                    } else {
                        const inputPath = path.join(directory, `input.${source.ext}`)
                        const outputPath = path.join(directory, 'sticker.webp')

                        await fs.writeFile(inputPath, input)

                        // GIF: pastikan jalur piksel punya alpha agar transparansi terjaga.
                        const pre = source.ext === 'gif' ? 'fps=12,format=rgba' : 'fps=12'

                        const filter = crop
                            ? `${pre},scale=512:512:force_original_aspect_ratio=increase,crop=512:512,format=yuva420p`
                            : `${pre},scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p`

                        await runFfmpeg([
                            '-i', inputPath,
                            '-t', '10',
                            '-vf', filter,
                            '-an',
                            '-c:v', 'libwebp_anim',
                            '-loop', '0',
                            '-quality', '40',
                            '-compression_level', '6',
                            '-preset', 'default',
                            outputPath
                        ])

                        sticker = await fs.readFile(outputPath)

                        if (sticker.length > 500 * 1024) {
                            throw new Error(
                                'Ukuran stiker animasi melebihi 500 KB. Coba gunakan video yang lebih pendek.'
                            )
                        }
                    }

                    await sock.sendMessage(
                        jid,
                        { sticker },
                        { quoted: message }
                    )

                } catch (error) {
                    console.error('Gagal membuat stiker:', error)

                    await sock.sendMessage(jid, {
                        text: `Gagal membuat stiker: ${error.message}`
                    }, { quoted: message })

                } finally {
                    await fs.rm(directory, {
                        recursive: true,
                        force: true
                    })
                }

                continue
            }


            // ==========================================
            // SOUND STICKER WHATSAPP
            // ==========================================
            // Input berupa video yang memiliki audio.

            if (/^\.sau(?:\s+--crop)?$/i.test(rawCommand)) {
                const quoted = getQuotedMessage(message, jid)

                const target =
                    getMediaKind(message) === 'video'
                        ? message
                        : quoted

                if (!target || getMediaKind(target) !== 'video') {
                    await sock.sendMessage(jid, {
                        text: 'Kirim video yang memiliki suara dengan caption *.sau* atau balas video dengan *.sau*. Tambahkan --crop untuk memotong video menjadi persegi.'
                    }, { quoted: message })

                    continue
                }

                const directory = await fs.mkdtemp(
                    path.join(os.tmpdir(), 'mettugi-sau-')
                )

                try {
                    const input = await downloadIncomingMedia(sock, target)

                    if (!input?.length) {
                        throw new Error('Video kosong atau gagal diunduh.')
                    }

                    if (input.length > MAX_MEDIA_SIZE) {
                        throw new Error('Ukuran video melebihi batas 50 MB.')
                    }

                    const inputPath = path.join(directory, 'input-video.mp4')

                    await fs.writeFile(inputPath, input)

                    await sock.sendMessage(jid, {
                        text: '⏳Loading....'
                    }, { quoted: message })

                    await sendSoundSticker(sock, jid, {
                        filePath: inputPath,
                        fit: /\s--crop$/i.test(rawCommand)
                            ? 'cover'
                            : 'contain',
                        packName: 'Mettugi',
                        publisher: 'Althea',
                        emojis: ['🔊'],
                        quoted: message
                    })

                } catch (error) {
                    console.error('Gagal membuat Sound Sticker:', error)

                    const reason =
                        error.userMessage ||
                        'Gagal membuat Sound Sticker. Pastikan video memiliki suara, FFmpeg berfungsi, dan ukuran video tidak lebih dari 50 MB.'

                    await sock.sendMessage(jid, {
                        text: reason
                    }, { quoted: message })

                } finally {
                    await fs.rm(directory, {
                        recursive: true,
                        force: true
                    })
                }

                continue
            }

            // ==========================================
            // STIKER -> GAMBAR / GIF, VIDEO -> GIF
            // ==========================================
            // Balas stiker dengan:
            // .toimg : diam -> gambar. Bergerak -> video (bersuara bila itu
            //          stiker audio), atau GIF bila tanpa suara
            // .togif : stiker bergerak -> GIF tanpa suara
            //          video biasa     -> GIF tanpa suara
            // .togif juga bisa dipakai sebagai caption saat mengirim video.

            const unstickerMatch = rawCommand.match(/^\.(toimg|togif)$/i)

            if (unstickerMatch) {
                const mode = unstickerMatch[1].toLowerCase()
                const quoted = getQuotedMessage(message, jid)
                const info = quoted ? findSticker(unwrapMessage(quoted)) : null

                // Video biasa (dikirim dengan caption .togif, atau dibalas).
                const videoTarget =
                    mode === 'togif'
                        ? (unwrapMessage(message).videoMessage
                            ? message
                            : (quoted && unwrapMessage(quoted).videoMessage ? quoted : null))
                        : null

                if (videoTarget) {
                    await sock.sendMessage(jid, {
                        text: '⏳Loading....'
                    }, { quoted: message })

                    try {
                        const videoBuffer = await downloadIncomingMedia(sock, videoTarget)

                        if (!videoBuffer?.length) {
                            throw new Error('Video kosong.')
                        }

                        await sock.sendMessage(jid, {
                            video: await convertVideoToGif(videoBuffer),
                            mimetype: 'video/mp4',
                            gifPlayback: true
                        }, { quoted: message })

                    } catch (error) {
                        console.error('Gagal mengubah video ke GIF:', error)

                        await sock.sendMessage(jid, {
                            text: 'Gagal mengubah video menjadi GIF. Pastikan FFmpeg terpasang.'
                        }, { quoted: message })
                    }

                    continue
                }

                if (!info) {
                    await sock.sendMessage(jid, {
                        text: 'Balas stiker dengan *.toimg* (otomatis gambar atau GIF), atau balas stiker/video dengan *.togif* (GIF tanpa suara).'
                    }, { quoted: message })

                    continue
                }

                await sock.sendMessage(jid, {
                    text: '⏳Loading....'
                }, { quoted: message })

                try {
                    const webp = await downloadIncomingMedia(sock, {
                        key: quoted.key,
                        message: { stickerMessage: info.sticker }
                    })

                    if (!webp?.length) {
                        throw new Error('Stiker kosong.')
                    }

                    // Suara stiker (bila ada). Gagal mengunduh suara tidak
                    // menggagalkan konversi, hasilnya hanya tanpa suara.
                    let audio = null

                    if (info.audio && mode !== 'togif') {
                        try {
                            audio = await downloadIncomingMedia(sock, {
                                key: quoted.key,
                                message: { audioMessage: info.audio }
                            })
                        } catch (error) {
                            console.error(
                                'Suara stiker tidak bisa diunduh:',
                                error.message
                            )
                        }
                    }

                    const result = await convertSticker({ webp, audio, mode })

                    if (result.type === 'image') {
                        await sock.sendMessage(jid, {
                            image: result.buffer,
                            mimetype: 'image/png'
                        }, { quoted: message })
                    } else {
                        await sock.sendMessage(jid, {
                            video: result.buffer,
                            mimetype: 'video/mp4',
                            gifPlayback: result.gif
                        }, { quoted: message })
                    }

                } catch (error) {
                    console.error('Gagal mengubah stiker:', error)

                    await sock.sendMessage(jid, {
                        text: error.userMessage ||
                            'Gagal mengubah stiker. Pastikan yang dibalas adalah stiker biasa dan FFmpeg terpasang.'
                    }, { quoted: message })
                }

                continue
            }

            // ==========================================
            // BRAT STICKER (IMAGE & VIDEO)
            // ==========================================
            // .brat / .bratwb       -> stiker gambar
            // .bratvid / .bratvidwb -> stiker video
            // Akhiran "wb" = mode putih-hitam, tanpa "wb" = mode bw

            const bratMatch = rawCommand.match(
                /^\.(bratvidwb|bratvid|bratwb|brat)\s+([\s\S]+)/i
            )

            if (bratMatch) {
                const cmd = bratMatch[1].toLowerCase()
                const bratText = bratMatch[2].trim()
                const mode = cmd.endsWith('wb') ? 'wb' : 'bw'
                const isVideo = cmd.startsWith('bratvid')

                if (!bratText) {
                    await sock.sendMessage(jid, {
                        text: `Masukkan teks setelah perintah .${cmd}.`
                    }, { quoted: message })

                    continue
                }

                await sock.sendMessage(jid, {
                    text: '⏳Loading....'
                }, { quoted: message })

                try {
                    const sticker = isVideo
                        ? await createBratVidSticker(bratText, mode)
                        : await createBratSticker(bratText, mode)

                    await sock.sendMessage(
                        jid,
                        { sticker },
                        { quoted: message }
                    )

                } catch (error) {
                    console.error('Gagal membuat stiker Brat:', error)

                    await sock.sendMessage(jid, {
                        text: isVideo
                            ? 'Gagal membuat stiker Brat video. Pastikan FFmpeg terpasang.'
                            : 'Gagal membuat stiker Brat.'
                    }, { quoted: message })
                }

                continue
            }

            // ==========================================
            // DOWNLOADER
            // ==========================================

            const downloaderMatch = rawCommand.match(
                /^\.(tt|yt|ig|fb|twt)\s+(https?:\/\/\S+)/i
            )

            if (downloaderMatch) {
                const platform = downloaderMatch[1].toLowerCase()

                const url = downloaderMatch[2].replace(/[),.]+$/, '')

                if (!isAllowedDownloadUrl(url, platform)) {
                    await sock.sendMessage(jid, {
                        text: 'Tautan tidak sesuai dengan perintah downloader atau domainnya tidak didukung.'
                    }, { quoted: message })

                    continue
                }

                const directory = await fs.mkdtemp(
                    path.join(os.tmpdir(), 'mettugi-download-')
                )

                try {
                    await sock.sendMessage(jid, {
                        text: '⏳Loading....'
                    }, { quoted: message })

                    const media = await downloadFromUrl(url, directory, platform)
                    const isVideo = /\.(mp4|m4v|mov|3gp|mkv|avi)$/i.test(media.ext)
                    const isImage = /\.(jpg|jpeg|png|webp|gif)$/i.test(media.ext)

                    if (isVideo && media.size <= MAX_WHATSAPP_VIDEO_SIZE) {
                        // Video kecil dikirim sebagai video agar langsung bisa diputar.
                        const mimetype = media.ext === '.mov'
                            ? 'video/quicktime'
                            : media.ext === '.3gp'
                                ? 'video/3gpp'
                                : media.ext === '.mkv'
                                    ? 'video/x-matroska'
                                    : media.ext === '.avi'
                                        ? 'video/x-msvideo'
                                        : 'video/mp4'

                        await sock.sendMessage(jid, {
                            video: { url: media.filePath },
                            mimetype,
                            caption: 'Berhasil mengunduh video.'
                        }, { quoted: message })

                    } else if (isImage && media.size <= MAX_WHATSAPP_VIDEO_SIZE) {
                        await sock.sendMessage(jid, {
                            image: { url: media.filePath },
                            caption: 'Berhasil mengunduh gambar.'
                        }, { quoted: message })

                    } else {
                        // Video di atas 64 MB dan file besar lain dikirim sebagai dokumen.
                        await sock.sendMessage(jid, {
                            document: { url: media.filePath },
                            mimetype: isVideo
                                ? 'video/mp4'
                                : 'application/octet-stream',
                            fileName: `mettugi${media.ext}`,
                            caption: isVideo
                                ? 'Video terlalu besar untuk dikirim sebagai media. Dikirim sebagai dokumen agar tetap dapat diunduh.'
                                : 'Berhasil mengunduh file.'
                        }, { quoted: message })
                    }

                } catch (error) {
                    // Log lengkap (termasuk keluaran yt-dlp) agar penyebabnya terlihat.
                    console.error(
                        `Gagal mengunduh dari ${platform}:`,
                        error.message
                    )

                    if (error.stderr) {
                        console.error(
                            String(error.stderr).trim().split('\n').slice(-15).join('\n')
                        )
                    }

                    const reason = explainDownloadError(error, platform)

                    await sock.sendMessage(jid, {
                        text: reason
                    }, { quoted: message })

                } finally {
                    await fs.rm(directory, {
                        recursive: true,
                        force: true
                    })
                }

                continue
            }

            // ==========================================
            // PESAN MENU WARUNG -> STIKER
            // ==========================================
            // Terpicu saat pengguna memilih menu dari tombol "Pilih Menu"
            // (pesan pilihan dari user), atau saat diketik manual:
            //   Pesan: Nasi
            // Jika namanya bukan menu warung, pesan diabaikan seperti
            // chat biasa. Respon bot: "ting!" lalu stikernya.

            const menuOrderMatch = rawCommand.match(/^pesan(?:\s+menu)?:[ \t]*([^\r\n]+)/i)
            const orderedItem = menuOrderMatch
                ? findWarungItem(menuOrderMatch[1])
                : null

            if (orderedItem) {
                const item = orderedItem

                try {
                    // Stiker disiapkan dulu agar "ting!" tidak terkirim
                    // kalau gambar menunya belum ada.
                    const sticker = await buildWarungSticker(item.file)

                    await sock.sendMessage(jid, {
                        text: '_ting!_ Pesanan siap!'
                    }, { quoted: message })

                    await sock.sendMessage(jid, { sticker })

                } catch (error) {
                    console.error('Gagal mengirim stiker menu:', error)

                    await sock.sendMessage(jid, {
                        text: error.code === 'ENOENT'
                            ? `Gambar untuk *${item.name}* belum ada. Simpan sebagai *assets/menu_warung/${item.file}*.`
                            : 'Gagal membuat stiker menu.'
                    }, { quoted: message })
                }

                continue
            }

            // ==========================================
            // RATE
            // ==========================================
            // .rate [pesan]?   (tanda tanya wajib di akhir pesan)

            const rateMatch = rawCommand.match(/^\.rate(?:\s+([\s\S]*))?$/i)

            if (rateMatch) {
                const raw = (rateMatch[1] || '').trim()
                const question = raw.replace(/[?？]+$/, '').trim()

                if (!/[?？]$/.test(raw) || !question) {
                    await sock.sendMessage(jid, {
                        text: 'Kirim pesan harus pakai tanda tanya (?) di akhir. Contoh: *.rate aku ganteng?*'
                    }, { quoted: message })

                    continue
                }

                const rate = Math.floor(Math.random() * 101)

                await sock.sendMessage(jid, {
                    text: `Hah, *${question}*, kamu tanya?\n_hmm....._ 🧐⏳\n\nRate pertanyaan kamu adalah: *${rate}%*`
                }, { quoted: message })

                await sock.sendMessage(jid, {
                    text: rateEmoji(rate).repeat(5)
                })

                if (rate === 100) {
                    try {
                        await sock.sendMessage(jid, {
                            sticker: await getRateSticker()
                        })
                    } catch (error) {
                        console.error('Gagal mengirim stiker rate (assets/wah.gif):', error.message)
                    }
                }

                continue
            }

            // ==========================================
            // HUSBU / WAIFU
            // ==========================================
            // .h / .husbu  dan  .w / .waifu

            const pairMatch = rawCommand.match(/^\.(husbu|h|waifu|w)$/i)

            if (pairMatch) {
                const kind = /^h/i.test(pairMatch[1]) ? 'husbu' : 'waifu'
                const rollerId = message.key.participant || message.participant || message.key.remoteJid

                // Jatah (per husbu/waifu) dipakai di awal; dikembalikan lagi kalau roll gagal.
                if (!(await reservePairRoll(rollerId, kind))) {
                    await sock.sendMessage(jid, {
                        text: PAIR_LIMIT_MESSAGE
                    }, { quoted: message })

                    continue
                }

                try {
                    const pair = await pickRandomPair(kind)

                    if (!pair) {
                        await refundPairRoll(rollerId, kind)

                        await sock.sendMessage(jid, {
                            text: `Belum ada gambar (PNG/JPG/JPEG) di folder *assets/${kind}*.`
                        }, { quoted: message })

                        continue
                    }

                    // Respons spesial: teks berurutan, lalu stiker GIF (kalau ada).
                    if (pair.special) {
                        const { messages, sticker: gifPath } = pair.special

                        let gifSticker = null

                        if (gifPath) {
                            try {
                                gifSticker = await getGifSticker(gifPath)
                            } catch (error) {
                                console.error(`Gagal membuat stiker spesial (${path.basename(gifPath)}):`, error.message)
                            }
                        }

                        for (let i = 0; i < messages.length; i++) {
                            await sock.sendMessage(
                                jid,
                                { text: messages[i] },
                                i === 0 ? { quoted: message } : undefined
                            )
                        }

                        if (gifSticker) {
                            await sock.sendMessage(jid, { sticker: gifSticker })
                        }

                        continue
                    }

                    // Stiker disiapkan dulu agar pesan tidak terkirim sendirian
                    // kalau gambarnya gagal diproses.
                    const sticker = await pairFileToSticker(pair.filePath)

                    await sock.sendMessage(jid, {
                        text: `Pasangan kamu hari ini adalah.... *${pair.name}*`
                    }, { quoted: message })

                    await sock.sendMessage(jid, { sticker })

                } catch (error) {
                    console.error(`Gagal memilih ${kind}:`, error.message)

                    await refundPairRoll(rollerId, kind)

                    await sock.sendMessage(jid, {
                        text: error.code === 'ENOENT'
                            ? `Folder *assets/${kind}* belum ada.`
                            : `Gagal mengambil ${kind}.`
                    }, { quoted: message })
                }

                continue
            }

            // ==========================================
            // MENU
            // ==========================================

            if (command === '.menu') {
                // Tag orang yang mengirim perintah.
                const sender = message.key.participant || message.participant
                const mentionTag = sender
                    ? `@${sender.split('@')[0]}`
                    : 'Warga'

                // Chat 1: kategori INFO
                await sock.sendMessage(jid, {
                    mentions: sender ? [sender] : [],
                    text:
`┏━━⬣ 𝙄𝙉𝙁𝙊
┃❏ Nama warga : ${mentionTag}
┃❏ Nama Bot : Althea
┃❏ Nama Owner : Ugioria
┃❏ Prefix :「 . 」
┃❏ Kepala Kampung : Yoshizawa Kou
┗━━⬣`
                }, { quoted: message })

                // Jeda 0.1 detik sebelum chat kedua
                await new Promise(resolve => setTimeout(resolve, 100))

                // Chat 2: kategori lainnya
                await sock.sendMessage(jid, {
                    text:
`╭─⬣「 𝙃𝙀𝙐𝙎𝘾𝙃𝙍𝙀𝘾𝙆𝙀 」⬣
│ ⛀ album
│ ⛀ pasal
├ ⛀ pasal rukun warga
├ ⛀ pasal perkampungan
├ ⛀ pasal kependudukan
├ ⛀ pasal pekerjaan
│ ⛀ sanksi
│ ⛀ pengumuman
└⬣

╭─⬣「 𝙃𝙄𝘽𝙐𝙍𝘼𝙉 」⬣
│ ⛀ rate
│ ⛀ husbu / h
│ ⛀ waifu / w
│ ⛀ koin
*BASE BOT*
│ ⛀ s
│ ⛀ sau 
│ ⛀ toimg
│ ⛀ togif
│ ⛀ bratvid
│ ⛀ brat
│ ⛀ tt / yt / ig / fb / twt
└⬣

╭─⬣「 𝙆𝘼𝙈𝙋𝙐𝙉𝙂 」⬣
│ ⛀ warung
└⬣

╭─⬣「 𝘼𝙆𝘼𝘿𝙀𝙈𝙄 」⬣
│ ⛀ bakat
└⬣

╭─⬣「 𝙀𝙑𝙀𝙉𝙏 」⬣
│ ⛀ !thr (Lebaran 2021)
│ ⛀ !panjat (Anniv 2022)
│ ⛀ !pinata (Halloween 2022)
└⬣

 ©Created : Ugioria`
                }, { quoted: message })
            }

            // ==========================================
            // PING
            // ==========================================

            else if (command === '.ping') {
                await sock.sendMessage(jid, {
                    text: 'Pong! Bot sedang aktif.'
                }, { quoted: message })
            }

            // ==========================================
            // KOIN (kepala / ekor, 50:50)
            // ==========================================

            else if (command === '.koin') {
                const sender = message.key.participant || message.participant
                const mentionTag = sender
                    ? `@${sender.split('@')[0]}`
                    : 'Warga'
                const hasil = Math.random() < 0.5 ? 'KEPALA' : 'EKOR'

                await sock.sendMessage(jid, {
                    mentions: sender ? [sender] : [],
                    text: `${mentionTag} melempar koin... *${hasil}*`
                }, { quoted: message })
            }

            // ==========================================
            // WARUNG METTUGI
            // ==========================================

            else if (command === '.warung') {
                await sendWarungMenu(sock, jid, message)
            }

            // ==========================================
            // SAPAAN (pagi / siang / sore / malam)
            // ==========================================
            // Hanya merespons chat teks yang isinya persis satu kata sapaan.

            else if (
                GREETINGS.includes(
                    (content.conversation || content.extendedTextMessage?.text || '')
                        .trim()
                        .toLowerCase()
                )
            ) {
                await sock.sendMessage(jid, {
                    text: command
                }, { quoted: message })
            }

            // ==========================================
            // ALBUM METTUGI
            // ==========================================

            else if (command === '.album') {
                await sock.sendMessage(jid, {
                    text: `*"Setiap sudut memiliki cerita, setiap warga meninggalkan jejak."*

Memori kami --
https://drive.google.com/folderview?id=1t4GBPS_v5jUA_NxZjzsRv0UUm9q3w7HV`
                }, { quoted: message })
            }

            // ==========================================
            // DAFTAR PASAL
            // ==========================================

            if (command === '.pasal') {
                await sock.sendMessage(jid, {
                    text: `**PERATURAN HEUSCHRECKE**

**Pasal 1: Rukun Warga**

**Ayat 1**
Setiap warga kampung memiliki hak untuk mendapatkan kedamaian dalam kampung.

**Ayat 2**
Setiap warga kampung diwajibkan untuk mencegah kerusuhan yang terjadi di dalam kampung.

**Ayat 3**
Apabila ada warga yang mengganggu kenyamanan warga lain, menyinggung dan membuatnya kesal, akan diberi sanksi sesuai keadaan yang terjadi.

**Ayat 4 (1)**
Setiap warga menciptakan toleransi dan tidak membeda-bedakan.

**Ayat 4 (2)**
Setiap warga dilarang SARA, baik berupa agama, ras, suku, budaya, dan sebagainya.

**Ayat 5**
Pendatang maupun warga yang tidak memiliki kontribusi tidak berhak mengubah tatanan kampung dalam segi apa pun.

---

**Pasal 2: Perkampungan**

**Ayat 1**
Setiap penghuni kampung memiliki hak untuk memiliki kartu penduduk kampung Mettugi dengan syarat aktif di kampung selama kurang lebih 7 hari.

**Ayat 2**
Setiap penghuni kampung dikategorikan sesuai dengan tingkat keaktifannya di dalam kampung.

**Ayat 3**
Rumah para penduduk kampung dikelompokkan berdasarkan status penduduk.

**Ayat 4 (1)**
Setiap warga kampung dianjurkan berkumpul di Club ketika malam hari.

**Ayat 4 (2)**
Setiap warga kampung memiliki kebebasan untuk melakukan apa pun di Club.

**Ayat 5**
Setiap warga kampung yang memiliki ikatan dengan supernatural diwajibkan mengikuti akademi sihir pada distrik Akrida.

**Ayat 6 (1)**
Tempat berbincang yang dianjurkan untuk penduduk adalah aula utama dan Warung.

**Ayat 6 (2)**
Seluruh penduduk kampung dianjurkan untuk mengikuti aturan dalam setiap tempat dan wilayah.

**Ayat 6 (3)**
Seluruh penduduk hanya dapat membeli makanan di Warung Mettugi.

**Ayat 6 (4)**
Penyetoran karya dalam bentuk apa pun pada Perpustakaan dengan mengikuti aturan yang ada.

---

**Pasal 3: Kependudukan**

**Ayat 1**
Setiap penduduk memiliki status dan jabatan yang berbeda.

**Ayat 2**
Setiap penduduk memiliki kewajiban untuk menunaikan tugas sesuai dengan status yang dimilikinya.

---

**Pasal 4: Pekerjaan**

**Ayat 1**
Setiap warga kampung paling banyak memiliki 3 jenis pekerjaan, tidak termasuk pada kedudukan organisasi yang dimiliki oleh warga.

**Ayat 2**
Setiap warga berhak menerima gaji sesuai dengan jenis dan jumlah pekerjaan yang dimilikinya dengan syarat: warga hanya menerima gaji setiap tanggal 10 sesuai waktu yang ditentukan.

**Ayat 3**
Setiap warga baru bisa mendapatkan haknya mencari kerja jika sudah memiliki Kartu Tanda Mettugi (KTM).

---

**SANKSI**

Berdasarkan aturan dan pasal yang berlaku, saya perwakilan dari kampung Mettugi memberikan sanksi kepada para pelanggar dengan metode level.

**Lv 1**
Warga akan menerima teguran biasa.

**Lv 2**
Warga akan menerima teguran keras.

**Lv 3**
Warga akan menerima sanksi berupa kick dari grup.

**Lv 4**
Warga akan dibanned dari kampung serta beberapa cabang grup ini.

---

**CATATAN**

1. Apabila dalam tindakan pelanggaran pertama merupakan tindakan yang mengandung SARA maupun membuat warga lain keluar, maka warga tersebut akan langsung memasuki Lv 3.

2. Apabila dalam 7 hari level pelanggaran warga terkait tidak bertambah, maka level pelanggaran warga tersebut akan kembali ke Lv 0.

---

**TTD - Wakil Kepala Desa Mettugi**`
                }, { quoted: message })
            }

            // ==========================================
            // PASAL 1: RUKUN WARGA
            // ==========================================

            else if (command === '.pasal rukun warga') {
                await sock.sendMessage(jid, {
                    text: `*PERATURAN HEUSCHRECKE*

*Pasal 1: Rukun Warga*

*Ayat 1*
Setiap warga kampung memiliki hak untuk mendapatkan kedamaian dalam kampung.

*Ayat 2*
Setiap warga kampung diwajibkan untuk mencegah kerusuhan yang terjadi di dalam kampung.

*Ayat 3*
Apabila ada warga yang mengganggu kenyamanan warga lain, menyinggung dan membuatnya kesal, akan diberi sanksi sesuai keadaan yang terjadi.

*Ayat 4 (1)*
Setiap warga menciptakan toleransi dan tidak membeda-bedakan.

*Ayat 4 (2)*
Setiap warga dilarang SARA, baik berupa agama, ras, suku, budaya, dan sebagainya.

*Ayat 5*
Pendatang maupun warga yang tidak memiliki kontribusi tidak berhak mengubah tatanan kampung dalam segi apa pun.`
                }, { quoted: message })
            }

            // ==========================================
            // PASAL 2: PERKAMPUNGAN
            // ==========================================

            else if (command === '.pasal perkampungan') {
                await sock.sendMessage(jid, {
                    text: `*PERATURAN HEUSCHRECKE*

*Pasal 2: Perkampungan*

*Ayat 1*
Setiap penghuni kampung memiliki hak untuk memiliki kartu penduduk kampung Mettugi dengan syarat aktif di kampung selama kurang lebih 7 hari.

*Ayat 2*
Setiap penghuni kampung dikategorikan sesuai dengan tingkat keaktifannya di dalam kampung.

*Ayat 3*
Rumah para penduduk kampung dikelompokkan berdasarkan status penduduk.

*Ayat 4 (1)*
Setiap warga kampung dianjurkan berkumpul di Club ketika malam hari.

*Ayat 4 (2)*
Setiap warga kampung memiliki kebebasan untuk melakukan apa pun di Club.

*Ayat 5*
Setiap warga kampung yang memiliki ikatan dengan supernatural diwajibkan mengikuti akademi sihir pada distrik Akrida.

*Ayat 6 (1)*
Tempat berbincang yang dianjurkan untuk penduduk adalah aula utama dan Warung.

*Ayat 6 (2)*
Seluruh penduduk kampung dianjurkan untuk mengikuti aturan dalam setiap tempat dan wilayah.

*Ayat 6 (3)*
Seluruh penduduk hanya dapat membeli makanan di Warung Mettugi.

*Ayat 6 (4)*
Penyetoran karya dalam bentuk apa pun pada Perpustakaan dengan mengikuti aturan yang ada.`
                }, { quoted: message })
            }

            // ==========================================
            // PASAL 3: KEPENDUDUKAN
            // ==========================================

            else if (command === '.pasal kependudukan') {
                await sock.sendMessage(jid, {
                    text: `*PERATURAN HEUSCHRECKE*

*Pasal 3: Kependudukan*

*Ayat 1*
Setiap penduduk memiliki status dan jabatan yang berbeda.

*Ayat 2*
Setiap penduduk memiliki kewajiban untuk menunaikan tugas sesuai dengan status yang dimilikinya.`
                }, { quoted: message })
            }

            // ==========================================
            // PASAL 4: PEKERJAAN
            // ==========================================

            else if (command === '.pasal pekerjaan') {
                await sock.sendMessage(jid, {
                    text: `*PERATURAN HEUSCHRECKE*

*Pasal 4: Pekerjaan*

*Ayat 1*
Setiap warga kampung paling banyak memiliki 3 jenis pekerjaan, tidak termasuk pada kedudukan organisasi yang dimiliki oleh warga.

*Ayat 2*
Setiap warga berhak menerima gaji sesuai dengan jenis dan jumlah pekerjaan yang dimilikinya dengan syarat: warga hanya menerima gaji setiap tanggal 10 sesuai waktu yang ditentukan.

*Ayat 3*
Setiap warga baru bisa mendapatkan haknya mencari kerja jika sudah memiliki Kartu Tanda Mettugi (KTM).`
                }, { quoted: message })
            }

            // ==========================================
            // SANKSI
            // ==========================================

            else if (command === '.sanksi') {
                await sock.sendMessage(jid, {
                    text: `*SANKSI*

Berdasarkan aturan dan pasal yang berlaku, saya perwakilan dari kampung Mettugi memberikan sanksi kepada para pelanggar dengan metode level.

*Lv 1*
Warga akan menerima teguran biasa.

*Lv 2*
Warga akan menerima teguran keras.

*Lv 3*
Warga akan menerima sanksi berupa kick dari grup.

*Lv 4*
Warga akan dibanned dari kampung serta beberapa cabang grup ini.

*CATATAN*

1. Apabila dalam tindakan pelanggaran pertama merupakan tindakan yang mengandung SARA maupun membuat warga lain keluar, maka warga tersebut akan langsung memasuki Lv 3.

2. Apabila dalam 7 hari level pelanggaran warga terkait tidak bertambah, maka level pelanggaran warga tersebut akan kembali ke Lv 0.

*TTD - Wakil Kepala Desa Mettugi*`
                }, { quoted: message })
            }
        }
    })
}

startBot().catch(error => {
    console.error('Bot mengalami error:', error)
})