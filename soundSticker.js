import {
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    proto
} from '@whiskeysockets/baileys'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

// ------------------------------------------------------------
// Sound sticker WhatsApp = stiker animasi (WebP) + audio (ogg/opus)
// yang diunggah terpisah lalu ditautkan dalam SATU pesan protobuf.
//
// PENTING: field protobuf untuk sound sticker BELUM ADA di Baileys
// (termasuk 7.0.0-rc terbaru), jadi update Baileys tidak membantu.
// Modul ini menambahkannya sendiri saat runtime (lihat patchProto)
// tanpa mengubah node_modules. Formatnya hasil reverse engineering
// komunitas dan bisa berubah kapan saja mengikuti update WhatsApp:
//
//   plain   : Message.stickerMessage(26) -> StickerMessage.audioMessage(26)
//             (bentuk yang dipakai bot RESBOT)
//   wrapper : Message.audioStickerMessage(134, FutureProofMessage)
//               -> Message.stickerMessage(26) -> audioMessage(26)
//             (bentuk yang dipakai beberapa proyek Baileys lain)
//
// Bila penerima hanya melihat stiker tanpa suara, coba mode lain:
//   set SOUND_STICKER_MODE=wrapper   (Windows CMD: set SOUND_STICKER_MODE=wrapper)
// ------------------------------------------------------------

const MODE = process.env.SOUND_STICKER_MODE === 'wrapper' ? 'wrapper' : 'plain'

const FIELD_STICKER_AUDIO = 26      // StickerMessage.audioMessage
const FIELD_AUDIO_STICKER = 134     // Message.audioStickerMessage

const MIME_AUDIO = 'audio/ogg; codecs=opus'
const UKURAN_STIKER = 512
const BATAS_STIKER_ANIMASI = 500 * 1024
const DURASI_MAKS = 10

// Durasi dicoba dari yang terpanjang; dipendekkan hanya bila ukuran
// stiker masih melebihi batas atau upload ditolak.
const DURASI_COBA = [DURASI_MAKS, 8, 6, 5]

// Tingkat kualitas per durasi, dari yang terbaik.
// `isi` = ukuran maksimal konten di dalam kanvas 512x512.
const TANGGA_KUALITAS = [
    { fps: 15, q: 50, isi: 512 },
    { fps: 12, q: 40, isi: 512 },
    { fps: 10, q: 30, isi: 400 },
    { fps: 8, q: 20, isi: 320 },
    { fps: 6, q: 15, isi: 256 }
]

// Error yang pesannya aman dan berguna untuk ditampilkan ke pengguna WhatsApp.
function userError(message) {
    const error = new Error(message)
    error.userMessage = message
    return error
}

// ------------------------------------------------------------
// ffmpeg
// ------------------------------------------------------------

async function runFfmpeg(args, timeout = 120000) {
    return execFileAsync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-y', ...args],
        { timeout, maxBuffer: 10 * 1024 * 1024 }
    )
}

// Durasi file (detik) dibaca dari keluaran ffmpeg, jadi tidak perlu ffprobe.
async function getDuration(filePath) {
    try {
        await execFileAsync('ffmpeg', ['-hide_banner', '-i', filePath], {
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024
        })
    } catch (error) {
        // ffmpeg tanpa output keluar dengan kode 1, info durasi ada di stderr.
        const match = String(error.stderr || '').match(
            /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
        )

        if (match) {
            return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
        }
    }

    return 0
}

const BISU = 'Video tersebut tidak memiliki suara yang dapat digunakan.'

// Audio -> ogg/opus mono (format voice WhatsApp), dipotong `detik`.
async function extractAudio(inputPath, outputPath, detik) {
    try {
        await runFfmpeg([
            '-i', inputPath,
            '-vn',
            '-t', String(detik),
            '-c:a', 'libopus',
            '-ac', '1',
            '-ar', '48000',
            '-b:a', '64k',
            '-f', 'ogg',
            outputPath
        ], 50000)
    } catch (error) {
        const pesan = String(error.stderr || error.message || error)

        if (/does not contain any stream|matches no streams|no audio/i.test(pesan)) {
            throw userError(BISU)
        }

        throw error
    }

    const stat = await fs.stat(outputPath).catch(() => null)

    if (!stat || stat.size === 0) throw userError(BISU)

    return {
        seconds: Math.max(1, Math.round(await getDuration(outputPath) || detik))
    }
}

// Video -> WebP animasi 512x512 (transparan di area kosong).
async function encodeSticker(inputPath, outputPath, { fps, q, isi }, durasi, fit) {
    const filter = fit === 'cover'
        ? `fps=${fps},scale=${UKURAN_STIKER}:${UKURAN_STIKER}:force_original_aspect_ratio=increase,` +
          `crop=${UKURAN_STIKER}:${UKURAN_STIKER},format=yuva420p`
        : `scale='min(${isi},iw)':'min(${isi},ih)':force_original_aspect_ratio=decrease,` +
          `fps=${fps},pad=${UKURAN_STIKER}:${UKURAN_STIKER}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p`

    await runFfmpeg([
        '-i', inputPath,
        '-ss', '0',
        '-t', String(durasi),
        '-vf', filter,
        '-an',
        '-c:v', 'libwebp_anim',
        '-lossless', '0',
        '-q:v', String(q),
        '-compression_level', '4',
        '-loop', '0',
        outputPath
    ])

    return fs.readFile(outputPath)
}

// Cari stiker terbaik yang <= BATAS_STIKER_ANIMASI.
// Mengembalikan stiker + durasi yang akhirnya dipakai (untuk memotong audio).
async function buildSticker(inputPath, directory, fit, videoDuration, mulai = 0) {
    const outputPath = path.join(directory, 'sticker.webp')
    let terkecil = null

    for (let i = mulai; i < DURASI_COBA.length; i++) {
        const terakhir = i === DURASI_COBA.length - 1
        const durasiCoba = DURASI_COBA[i]

        // Video yang lebih pendek dari durasi ini hasilnya sama persis
        // dengan percobaan sebelumnya, jadi dilewati.
        if (!terakhir && videoDuration && durasiCoba >= videoDuration + 0.5 && i > mulai) {
            continue
        }

        const durasi = videoDuration
            ? Math.min(durasiCoba, videoDuration)
            : durasiCoba

        for (const tingkat of TANGGA_KUALITAS) {
            const buffer = await encodeSticker(
                inputPath, outputPath, tingkat, durasi.toFixed(2), fit
            )

            if (!terkecil || buffer.length < terkecil.buffer.length) {
                terkecil = { buffer, durasi, indeks: i }
            }

            if (buffer.length <= BATAS_STIKER_ANIMASI) {
                return { buffer, durasi, indeks: i }
            }
        }
    }

    throw userError(
        `Video terlalu ramai, stikernya tetap ${Math.round((terkecil?.buffer.length || 0) / 1024)} KB ` +
        `(batas WhatsApp ${BATAS_STIKER_ANIMASI / 1024} KB). Coba video yang lebih sederhana.`
    )
}

// ------------------------------------------------------------
// EXIF paket stiker (tanpa library tambahan)
// Disisipkan langsung di level chunk RIFF, jadi frame animasi dan
// transparansinya tidak tersentuh.
// ------------------------------------------------------------

function buildExif({ packName, publisher, emojis }) {
    const json = Buffer.from(JSON.stringify({
        'sticker-pack-id': crypto.randomUUID(),
        'sticker-pack-name': packName || '',
        'sticker-pack-publisher': publisher || '',
        emojis: emojis?.length ? emojis : ['']
    }), 'utf8')

    const header = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ])

    header.writeUInt32LE(json.length, 14)

    return Buffer.concat([header, json])
}

function addExif(webp, meta) {
    if (
        webp.length < 20 ||
        webp.toString('ascii', 0, 4) !== 'RIFF' ||
        webp.toString('ascii', 8, 12) !== 'WEBP'
    ) {
        throw new Error('Hasil stiker bukan file WebP yang valid.')
    }

    const exif = buildExif(meta)
    let body = webp.subarray(12)
    const firstChunk = body.toString('ascii', 0, 4)

    if (firstChunk === 'VP8X') {
        // Nyalakan flag EXIF (bit 0x08) pada VP8X yang sudah ada.
        body = Buffer.from(body)
        body[8] |= 0x08
    } else {
        // WebP sederhana (1 frame): buat VP8X baru. Kanvas selalu 512x512.
        const vp8x = Buffer.alloc(18)
        vp8x.write('VP8X', 0, 'ascii')
        vp8x.writeUInt32LE(10, 4)
        vp8x[8] = 0x18                            // alpha + EXIF
        vp8x.writeUIntLE(UKURAN_STIKER - 1, 12, 3)
        vp8x.writeUIntLE(UKURAN_STIKER - 1, 15, 3)
        body = Buffer.concat([vp8x, body])
    }

    const chunkHeader = Buffer.alloc(8)
    chunkHeader.write('EXIF', 0, 'ascii')
    chunkHeader.writeUInt32LE(exif.length, 4)

    const padding = exif.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)
    const merged = Buffer.concat([body, chunkHeader, exif, padding])

    const riff = Buffer.alloc(12)
    riff.write('RIFF', 0, 'ascii')
    riff.writeUInt32LE(merged.length + 4, 4)
    riff.write('WEBP', 8, 'ascii')

    return Buffer.concat([riff, merged])
}

// ------------------------------------------------------------
// Patch protobuf (runtime)
// Menambahkan field yang belum dikenal Baileys ke proses encode.
// Field ditulis di akhir pesan, dan urutan field tidak berpengaruh
// pada protobuf. Pesan lain tidak berubah sama sekali.
// ------------------------------------------------------------

const PATCHED = Symbol.for('mettugi.soundSticker.patched')

function patchProto() {
    const Message = proto.Message

    if (Message[PATCHED]) return

    const StickerMessage = Message.StickerMessage
    const encodeSticker = StickerMessage.encode
    const encodeMessage = Message.encode

    // Versi Baileys masa depan mungkin sudah mengenal field ini. Jika ya,
    // jangan menulisnya dua kali.
    const nativeSticker =
        encodeSticker({ audioMessage: { seconds: 1 } }).finish().length > 0
    const nativeWrapper =
        encodeMessage({ audioStickerMessage: { message: {} } }).finish().length > 0

    if (!nativeSticker) {
        StickerMessage.encode = function (message, writer) {
            const w = encodeSticker.call(this, message, writer)

            if (message?.audioMessage) {
                const bytes = Message.AudioMessage.encode(message.audioMessage).finish()
                w.uint32((FIELD_STICKER_AUDIO << 3) | 2).bytes(bytes)
            }

            return w
        }
    }

    if (!nativeWrapper) {
        Message.encode = function (message, writer) {
            const w = encodeMessage.call(this, message, writer)

            if (message?.audioStickerMessage) {
                const bytes = Message.FutureProofMessage
                    .encode(message.audioStickerMessage)
                    .finish()
                w.uint32((FIELD_AUDIO_STICKER << 3) | 2).bytes(bytes)
            }

            return w
        }
    }

    Object.defineProperty(Message, PATCHED, { value: true })
}

// Pastikan suaranya benar-benar ikut ter-encode, supaya tidak ada stiker
// bisu yang terkirim diam-diam.
function verifyPatch() {
    const audio = { mimetype: MIME_AUDIO, seconds: 1 }
    const sticker = { mimetype: 'image/webp', isAnimated: true, audioMessage: audio }
    const content = MODE === 'wrapper'
        ? { audioStickerMessage: { message: { stickerMessage: sticker } } }
        : { stickerMessage: sticker }

    const audioBytes = Buffer.from(proto.Message.AudioMessage.encode(audio).finish())
    const encoded = Buffer.from(proto.Message.encode(content).finish())

    return encoded.includes(audioBytes)
}

let patchReady = false

function ensurePatched() {
    if (patchReady) return

    try {
        patchProto()

        if (!verifyPatch()) throw new Error('verifikasi encode gagal')
    } catch (error) {
        throw userError(
            'Gagal menyiapkan dukungan stiker bersuara pada Baileys ' +
            `(${error.message}). Versi Baileys yang dipakai mungkin berbeda dari yang didukung.`
        )
    }

    patchReady = true
}

// ------------------------------------------------------------
// Kirim ke WhatsApp
// ------------------------------------------------------------

function buildContextInfo(quoted) {
    return {
        stanzaId: quoted.key.id,
        participant: quoted.key.participant || quoted.key.remoteJid,
        quotedMessage: quoted.message
    }
}

async function sendStickerWithAudio(sock, jid, { webp, audio, seconds, quoted }) {
    ensurePatched()

    const sticker = await prepareWAMessageMedia(
        { sticker: webp },
        { upload: sock.waUploadToServer }
    )

    const voice = await prepareWAMessageMedia(
        { audio, mimetype: MIME_AUDIO, seconds, ptt: false },
        { upload: sock.waUploadToServer }
    )

    const stickerMessage = {
        ...sticker.stickerMessage,
        width: UKURAN_STIKER,
        height: UKURAN_STIKER,
        isAnimated: true,
        audioMessage: voice.audioMessage
    }

    let content

    if (MODE === 'wrapper') {
        // Pembungkus bukan tipe media, jadi balasan (quote) dipasang manual
        // di dalam stickerMessage.
        if (quoted) stickerMessage.contextInfo = buildContextInfo(quoted)

        content = { audioStickerMessage: { message: { stickerMessage } } }
    } else {
        content = { stickerMessage }
    }

    const message = generateWAMessageFromContent(jid, content, {
        quoted: MODE === 'plain' ? quoted : undefined,
        userJid: sock.user?.id
    })

    await sock.relayMessage(jid, message.message, { messageId: message.key.id })
}

// ------------------------------------------------------------
// API utama
// ------------------------------------------------------------

/**
 * Video bersuara -> sound sticker.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} opsi
 * @param {string} opsi.filePath   path video input
 * @param {'contain'|'cover'} [opsi.fit]  contain = utuh, cover = dipotong persegi
 * @param {string} [opsi.packName]
 * @param {string} [opsi.publisher]
 * @param {string[]} [opsi.emojis]
 * @param {object} [opsi.quoted]   pesan yang dibalas
 */
export async function sendSoundSticker(sock, jid, {
    filePath,
    fit = 'contain',
    packName = '',
    publisher = '',
    emojis = ['🔊'],
    quoted
}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mettugi-sau-'))

    try {
        const videoDuration = await getDuration(filePath)

        // Pastikan video punya suara sebelum repot membuat stiker.
        const audioPath = path.join(directory, 'audio.ogg')
        await extractAudio(filePath, audioPath, Math.min(videoDuration || DURASI_MAKS, DURASI_MAKS))

        let mulai = 0

        for (;;) {
            const sticker = await buildSticker(filePath, directory, fit, videoDuration, mulai)

            // Audio dipotong sepanjang stiker yang akhirnya dipakai.
            const { seconds } = await extractAudio(filePath, audioPath, sticker.durasi.toFixed(2))

            const webp = addExif(sticker.buffer, { packName, publisher, emojis })

            try {
                await sendStickerWithAudio(sock, jid, {
                    webp,
                    audio: await fs.readFile(audioPath),
                    seconds,
                    quoted
                })

                return
            } catch (error) {
                // Upload ditolak karena kebesaran -> ulangi dengan durasi lebih pendek.
                const kebesaran = /\b413\b|too large|payload/i.test(String(error?.message || error))

                if (kebesaran && sticker.indeks < DURASI_COBA.length - 1) {
                    mulai = sticker.indeks + 1
                    continue
                }

                throw error
            }
        }
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
}
