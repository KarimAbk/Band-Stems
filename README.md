# Band Stems

Synced multitrack player. Everyone loads the same stems on their own phone, one person hosts, the others follow Play/Pause. Each person has their own mixer.

## Try it on your computer
    npm install
    npm start
Open http://localhost:3000 in two browser tabs (host in one, join in the other).
Phones on your Wi-Fi can use http://YOUR-COMPUTER-IP:3000, but camera recording needs https, so deploy for the full app.

## Deploy free on Render (gives you https)
1. Create a free GitHub account and a new repository. Upload this whole folder (server.js, package.json, public/).
2. Create a free account at render.com and choose New > Web Service. Connect the repository.
3. Settings: Runtime Node, Build Command `npm install`, Start Command `npm start`, Instance type Free.
4. When it finishes you get a link like https://band-stems.onrender.com. Send it to your band.
Free instances sleep after ~15 minutes idle, so the first load can take up to a minute. Open it a minute before rehearsal.

## Using it
- Only the host picks the stems: they are uploaded to the server and every follower downloads them automatically (limit 200 MB per room, 95 MB per file). The server deletes them when the room empties or restarts.
- Formats: mp3, m4a, wav, ogg, flac, webm (depends on the phone's browser: Safari may not play webm).
- Everyone: open the link, tap Load stems, pick the same files.
- Host: type a long room code, tap Host. Others: same code, tap Join.
- Only the host sees Play/Pause/seek. Rejoining as Host in the same room takes over hosting.

## Mac separator (optional)
Set an environment variable SEPARATOR_KEY on the server (Render > Environment). Then run the separator from the band-stems-separator folder on your Mac (see its README.txt). The host gets a "Separate a song" button.

## Extras
- Count-in (4 or 8 beats at a chosen BPM), played in sync on every phone before the song starts.
- Host can tap a stem name to rename it for everyone. Anyone can remove a stem from their own mixer with the cross.
- The host's browser remembers the last song: "Load last song" re-shares it after the server restarts.
