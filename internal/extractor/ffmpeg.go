package extractor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// durationRe matches the "Duration: HH:MM:SS.mm" line in ffmpeg stderr output.
var durationRe = regexp.MustCompile(`Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)`)

// ExtractFrames runs ffmpeg to extract video frames at 1 fps as JPEG images.
// It writes frames to outputDir as 0001.jpg, 0002.jpg, etc. and returns the
// total number of frames extracted.
func ExtractFrames(inputPath, outputDir string) (int, error) {
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return 0, fmt.Errorf("create output dir: %w", err)
	}

	pattern := filepath.Join(outputDir, "%04d.jpg")

	cmd := exec.Command("ffmpeg",
		"-i", inputPath,
		"-vf", "fps=1",
		"-q:v", "2",
		pattern,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("ffmpeg extract frames: %w: %s", err, string(out))
	}

	entries, err := os.ReadDir(outputDir)
	if err != nil {
		return 0, fmt.Errorf("read output dir: %w", err)
	}

	count := 0
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".jpg") {
			count++
		}
	}

	if count == 0 {
		return 0, fmt.Errorf("ffmpeg produced no frames")
	}

	return count, nil
}

// ExtractAudio extracts the audio track from a video file as a 16 kHz mono
// PCM WAV file suitable for speech processing pipelines.
func ExtractAudio(inputPath, outputPath string) error {
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}

	cmd := exec.Command("ffmpeg",
		"-i", inputPath,
		"-vn",
		"-acodec", "pcm_s16le",
		"-ar", "16000",
		"-ac", "1",
		"-y",
		outputPath,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg extract audio: %w: %s", err, string(out))
	}
	return nil
}

// GetDuration returns the duration of a media file in milliseconds by parsing
// ffmpeg's stderr output.
func GetDuration(inputPath string) (int64, error) {
	cmd := exec.Command("ffmpeg", "-i", inputPath)
	// ffmpeg writes info to stderr when given no output; it exits non-zero,
	// so we capture stderr directly.
	out, _ := cmd.CombinedOutput()

	matches := durationRe.FindSubmatch(out)
	if matches == nil {
		return 0, fmt.Errorf("could not parse duration from ffmpeg output")
	}

	hours, _ := strconv.ParseInt(string(matches[1]), 10, 64)
	minutes, _ := strconv.ParseInt(string(matches[2]), 10, 64)
	seconds, _ := strconv.ParseInt(string(matches[3]), 10, 64)

	// The fractional part may be 2 digits (centiseconds) or more.
	fracStr := string(matches[4])
	frac, _ := strconv.ParseInt(fracStr, 10, 64)
	// Normalise to milliseconds: if 2 digits multiply by 10, if 3 digits use
	// as-is, etc.
	switch len(fracStr) {
	case 1:
		frac *= 100
	case 2:
		frac *= 10
	case 3:
		// already milliseconds
	default:
		// truncate to ms precision
		for len(fracStr) > 3 {
			frac /= 10
			fracStr = fracStr[:len(fracStr)-1]
		}
	}

	ms := hours*3600000 + minutes*60000 + seconds*1000 + frac
	return ms, nil
}

// ProbeFormat returns the format and codec information for a media file by
// running ffprobe. The result is the raw text output from ffprobe -show_format.
func ProbeFormat(inputPath string) (string, error) {
	cmd := exec.Command("ffprobe",
		"-v", "error",
		"-show_format",
		"-of", "default",
		inputPath,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("ffprobe: %w: %s", err, string(out))
	}
	return string(out), nil
}
