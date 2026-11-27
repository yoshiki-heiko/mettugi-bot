import sharp from 'sharp'
import { proto } from '@whiskeysockets/baileys'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

// ------------------------------------------------------------
// Error yang pesannya aman ditampilkan ke pengguna WhatsApp.
// ------------------------------------------------------------

function userError(message) {
    const error = new Error(message)
    error.userMessage = message
    return error
}

// ------------------------------------------------------------
// Patch DECODE untuk sound sticker
//
// Baileys belum mengenal field audio pada stiker, jadi saat pesan
// diterima bagian suaranya dibuang diam-diam:
//   Message.audioStickerMessage(134) -> FutureProofMessage -> Message
//   StickerMessage.audioMessage(26)  -> AudioMessage
// Patch ini membaca field tersebut langsung dari byte pesan dan
// menempelkannya kembali ke objek hasil decode. Pesan lain tidak
// berubah, dan jika terjadi error, hasil decode asli dikembalikan.
// Pasangan patch ENCODE (untuk mengirim) ada di soundSticker.js.
// ------------------------------------------------------------

const FIELD_STICKER_AUDIO = 26
const FIELD_AUDIO_STICKER = 134
const DECODE_PATCHED = Symbol.for('mettugi.soundSticker.decodePatched')

// Cari isi field `field` (tipe length-delimited) di dalam buf[start, end).
function scanField(buf, start, end, field) {
    let pos = start
    let found = null

    const readVarint = () => {
        let result = 0
        let shift = 0
        let byte

        do {
            if (pos >= end) throw new RangeError('varint melewati batas')
            byte = buf[pos++]
            result += (byte & 0x7f) * 2 ** shift
            shift += 7
        } while (byte & 0x80)

        return result
    }

    while (pos < end) {
        const tag = readVarint()
        const wire = tag & 7
        const id = Math.floor(tag / 8)

        if (wire === 0) {
            readVarint()
        } else if (wire === 1) {
            pos += 8
        } else if (wire === 5) {
            pos += 4
        } else if (wire === 2) {
            const length = readVarint()

            if (id === field) found = buf.subarray(pos, pos + length)

            pos += length
        } else {
            return found    // tipe group / tidak dikenal: berhenti
        }
    }

    return found
}

// Rentang byte yang akan dibaca decode(), dihitung SEBELUM decode asli
// menggeser posisi reader.
function readSpan(reader, length) {
    if (reader && typeof reader.pos === 'number' && reader.buf) {
        return {
            buf: reader.buf,
            start: reader.pos,
            end: length === undefined ? reader.len : reader.pos + length
        }
    }

    if (reader instanceof Uint8Array) {
        return {
            buf: reader,
            start: 0,
            end: length === undefined ? reader.length : length
        }
    }

    return null
}

export function enableSoundStickerDecode() {
    const Message = proto.Message

    if (Message[DECODE_PATCHED]) return

    const StickerMessage = Message.StickerMessage
    const decodeSticker = StickerMessage.decode
    const decodeMessage = Message.decode

    // Versi Baileys masa depan mungkin sudah mengenal field ini sendiri.
    // Jika ya, patch yang bersangkutan tidak dipasang.
    let nativeSticker = false
    let nativeWrapper = false

    try {
        // StickerMessage { field 26: AudioMessage { seconds: 1 } }
        const stickerProbe = Buffer.from([0xd2, 0x01, 0x02, 0x28, 0x01])
        nativeSticker = !!decodeSticker.call(StickerMessage, stickerProbe).audioMessage

        // Message { field 134: FutureProofMessage { message: Message {} } }
        const wrapperProbe = Buffer.from([0xb2, 0x08, 0x02, 0x0a, 0x00])
        nativeWrapper = !!decodeMessage.call(Message, wrapperProbe).audioStickerMessage
    } catch {
        // abaikan, anggap belum didukung
    }

    if (!nativeSticker) {
        StickerMessage.decode = function (reader, length, ...rest) {
            const span = readSpan(reader, length)
            const message = decodeSticker.call(this, reader, length, ...rest)

            try {
                if (span && !message.audioMessage) {
                    const raw = scanField(span.buf, span.start, span.end, FIELD_STICKER_AUDIO)

                    if (raw) message.audioMessage = Message.AudioMessage.decode(raw)
                }
            } catch {
                // gagal membaca audio -> stiker tetap dipakai tanpa suara
            }

            return message
        }
    }

    if (!nativeWrapper) {
        Message.decode = function (reader, length, ...rest) {
            const span = readSpan(reader, length)
            const message = decodeMessage.call(this, reader, length, ...rest)

            try {
                if (span && !message.audioStickerMessage) {
                    const raw = scanField(span.buf, span.start, span.end, FIELD_AUDIO_STICKER)

                    if (raw) {
                        message.audioStickerMessage = Message.FutureProofMessage.decode(raw)
                    }
                }
            } catch {
                // abaikan
            }

            return message
        }
    }

    Object.defineProperty(Message, DECODE_PATCHED, { value: true })
}

// ------------------------------------------------------------
// Mengambil stiker (dan suaranya, bila ada) dari isi pesan.
// Sound sticker bisa datang sebagai stickerMessage biasa atau
// dibungkus audioStickerMessage.
// ------------------------------------------------------------

export function findSticker(content) {
    const sticker =
        content?.stickerMessage ||
        content?.audioStickerMessage?.message?.stickerMessage ||
        null

    if (!sticker) return null

    return {
        sticker,
        audio: sticker.audioMessage || null
    }
}

// ------------------------------------------------------------
// Deteksi stiker bergerak langsung dari struktur WebP, karena flag
// isAnimated pada pesan tidak selalu terisi.
// ------------------------------------------------------------

export function isAnimatedWebp(webp) {
    if (
        webp.length < 16 ||
        webp.toString('ascii', 0, 4) !== 'RIFF' ||
        webp.toString('ascii', 8, 12) !== 'WEBP'
    ) {
        return false
    }

    let pos = 12

    while (pos + 8 <= webp.length) {
        const type = webp.toString('ascii', pos, pos + 4)
        const size = webp.readUInt32LE(pos + 4)

        if (type === 'ANIM' || type === 'ANMF') return true

        pos += 8 + size + (size % 2)
    }

    return false
}

// ------------------------------------------------------------
// Konversi
// ------------------------------------------------------------

const MIN_DELAY_MS = 20
const DEFAULT_DELAY_MS = 100
const BACKGROUND = '#000000'     // area transparan pada video menjadi hitam

async function runFfmpeg(args, cwd) {
    return execFileAsync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-y', ...args],
        { cwd, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
    )
}

/**
 * @param {object} opsi
 * @param {Buffer} opsi.webp   stiker
 * @param {Buffer|null} [opsi.audio]  suara stiker (ogg/opus), bila ada
 * @param {'toimg'|'togif'} [opsi.mode]
 *   toimg : diam -> gambar; gerak -> video bersuara bila ada suara, selain itu GIF
 *   togif : gerak -> GIF tanpa suara
 * @returns {{type:'image', buffer:Buffer} |
 *           {type:'video', buffer:Buffer, gif:boolean, hasAudio:boolean}}
 */
export async function convertSticker({ webp, audio = null, mode = 'toimg' }) {
    // Stiker diam -> gambar PNG (transparansi dipertahankan).
    if (!isAnimatedWebp(webp)) {
        return {
            type: 'image',
            buffer: await sharp(webp).png().toBuffer()
        }
    }

    const meta = await sharp(webp, { animated: true }).metadata()
    const pages = meta.pages || 1

    if (pages < 2) {
        return {
            type: 'image',
            buffer: await sharp(webp).png().toBuffer()
        }
    }

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mettugi-unsticker-'))

    try {
        // 1. Ekstrak setiap frame (ffmpeg tidak bisa membaca WebP animasi).
        const durations = []
        const listLines = ['ffconcat version 1.0']

        for (let i = 0; i < pages; i++) {
            const name = `frame_${String(i).padStart(4, '0')}.png`

            await sharp(webp, { page: i })
                .flatten({ background: BACKGROUND })
                .png()
                .toFile(path.join(directory, name))

            let delay = meta.delay?.[i]

            if (!delay || delay <= 10) delay = DEFAULT_DELAY_MS

            delay = Math.max(delay, MIN_DELAY_MS)
            durations.push(delay / 1000)

            listLines.push(`file '${name}'`, `duration ${(delay / 1000).toFixed(3)}`)
        }

        // Frame terakhir diulang agar durasinya dihormati ffmpeg.
        listLines.push(`file 'frame_${String(pages - 1).padStart(4, '0')}.png'`)

        await fs.writeFile(path.join(directory, 'list.txt'), listLines.join('\n'))

        const total = durations.reduce((sum, d) => sum + d, 0)
        const withAudio = !!audio?.length && mode !== 'togif'
        const gif = mode === 'togif' || (mode === 'toimg' && !withAudio)

        const videoArgs = [
            '-f', 'concat', '-i', 'list.txt'
        ]

        const encodeArgs = [
            '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-movflags', '+faststart'
        ]

        // 2. Rakit video. Bila memakai suara dan gagal, ulangi tanpa suara.
        let hasAudio = false

        if (withAudio) {
            try {
                await fs.writeFile(path.join(directory, 'audio.ogg'), audio)

                await runFfmpeg([
                    ...videoArgs,
                    '-i', 'audio.ogg',
                    ...encodeArgs,
                    '-map', '0:v:0',
                    '-map', '1:a:0',
                    '-c:a', 'aac',
                    '-b:a', '96k',
                    '-t', total.toFixed(3),
                    'out.mp4'
                ], directory)

                hasAudio = true
            } catch (error) {
                console.error('Suara stiker gagal digabung, memakai video tanpa suara:', error.message)
            }
        }

        if (!hasAudio) {
            await runFfmpeg([
                ...videoArgs,
                ...encodeArgs,
                '-an',
                'out.mp4'
            ], directory)
        }

        const buffer = await fs.readFile(path.join(directory, 'out.mp4'))

        if (!buffer.length) throw userError('Hasil konversi kosong.')

        return {
            type: 'video',
            buffer,
            gif: gif && !hasAudio,
            hasAudio
        }

    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
}
