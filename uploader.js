name: Remote Split & Multi-Account Upload

on:
  workflow_dispatch:
    inputs:
      file_url:
        description: 'Direct HTTPS URL to the video'
        required: true
      file_name:
        description: 'Target Base Name (e.g. Spider-Man.2.2004.1080p)'
        required: true

permissions:
  contents: read

jobs:
  split_and_upload:
    runs-on: ubuntu-latest

    steps:
      - name: Free Up Disk Space
        run: |
          sudo rm -rf /usr/share/dotnet
          sudo rm -rf /opt/ghc
          sudo rm -rf "/usr/local/share/boost"
          sudo rm -rf "$AGENT_TOOLSDIRECTORY"
          sudo rm -rf /usr/local/lib/android

      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Cache APT Packages
        uses: actions/cache@v4
        with:
          path: /var/cache/apt/archives
          key: apt-media-tools-${{ runner.os }}

      - name: Install System Tools (FFmpeg, MKVToolNix, Aria2)
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends ffmpeg mkvtoolnix aria2

      - name: High-Speed Multi-Connection Download (aria2c)
        run: |
          echo "Downloading source file via 16 parallel sockets..."
          aria2c -x 16 -s 16 -k 1M \
            --file-allocation=none \
            --summary-interval=5 \
            -o "source_input.mkv" \
            "${{ inputs.file_url }}"

      - name: Lossless Slice to MPEG-TS (Stream-Concatenation Ready)
        run: |
          echo "Slicing lossless MPEG-TS segments (1 hour cuts, <3.8GB safe limit)..."
          ffmpeg -y -i "source_input.mkv" \
            -c copy \
            -map 0:v -map 0:a \
            -f segment \
            -segment_time 3600 \
            -reset_timestamps 0 \
            "part-%02d.ts"

          rm -f "source_input.mkv"
          ls -lh part-*.ts

      - name: Distribute Chunks to uDrop Accounts
        env:
          UDROP_ACCOUNTS_JSON: ${{ secrets.UDROP_ACCOUNTS_JSON }}
          BASE_NAME: ${{ inputs.file_name }}
        run: node uploader.js
