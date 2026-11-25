package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path"
	"strings"
	"syscall"
	"time"
)

//go:embed web
var embeddedWeb embed.FS

const (
	appName    = "ubicate"
	appVersion = "1.0.0"
)

const contentSecurityPolicy = "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com; connect-src 'self' https://nominatim.openstreetmap.org https://get.geojs.io https://freeipapi.com; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'; worker-src 'self'"

var contentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".json":        "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".ico":         "image/x-icon",
	".txt":         "text/plain; charset=utf-8",
}

type server struct {
	web fs.FS
}

type healthResponse struct {
	Status  string    `json:"status"`
	Service string    `json:"service"`
	Version string    `json:"version"`
	Time    time.Time `json:"time"`
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

func main() {
	defaultAddr := ":8080"
	if port := os.Getenv("PORT"); port != "" {
		defaultAddr = ":" + port
	}

	addr := flag.String("addr", defaultAddr, "dirección donde escucha el servidor")
	certFile := flag.String("cert", "", "certificado TLS en formato PEM (opcional)")
	keyFile := flag.String("key", "", "clave TLS en formato PEM (opcional)")
	flag.Parse()

	web, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		log.Fatalf("no se pudo cargar la interfaz web: %v", err)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           newHandler(web),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		tlsEnabled := *certFile != "" || *keyFile != ""
		printBanner(*addr, tlsEnabled)

		if tlsEnabled {
			if *certFile == "" || *keyFile == "" {
				errCh <- errors.New("debes indicar -cert y -key juntos")
				return
			}
			errCh <- srv.ListenAndServeTLS(*certFile, *keyFile)
			return
		}
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("error del servidor: %v", err)
		}
	case <-ctx.Done():
		log.Println("apagando servidor…")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("apagado forzado: %v", err)
		}
	}
}

func newHandler(web fs.FS) http.Handler {
	s := &server{web: web}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/", s.handleStatic)

	return withLogging(withSecurity(mux))
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "método no permitido", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(healthResponse{
		Status:  "ok",
		Service: "ubicate",
		Version: appVersion,
		Time:    time.Now().UTC(),
	})
}

func (s *server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "método no permitido", http.StatusMethodNotAllowed)
		return
	}

	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" || name == "." {
		name = "index.html"
	}
	if strings.HasSuffix(r.URL.Path, "/") && name != "index.html" {
		name = path.Join(name, "index.html")
	}

	data, err := fs.ReadFile(s.web, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	ext := strings.ToLower(path.Ext(name))
	contentType, ok := contentTypes[ext]
	if !ok {
		contentType = mime.TypeByExtension(ext)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", cachePolicy(name))
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}

func cachePolicy(name string) string {
	switch {
	case name == "index.html",
		name == "sw.js",
		name == "manifest.webmanifest",
		strings.HasSuffix(name, ".js"),
		strings.HasSuffix(name, ".css"):
		return "no-cache"
	default:
		return "public, max-age=86400"
	}
}

func withSecurity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "geolocation=(self), camera=(), microphone=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %s -> %d (%d B, %s)", r.RemoteAddr, r.Method, r.URL.RequestURI(), rec.status, rec.bytes, time.Since(start).Round(time.Millisecond))
	})
}

func printBanner(addr string, tlsEnabled bool) {
	scheme := "http"
	if tlsEnabled {
		scheme = "https"
	}

	port := "8080"
	if _, p, err := net.SplitHostPort(addr); err == nil && p != "" {
		port = p
	}

	fmt.Printf("\n  %s v%s\n", appName, appVersion)
	fmt.Printf("  Local:  %s://localhost:%s\n", scheme, port)
	for _, ip := range lanIPs() {
		fmt.Printf("  Red:    %s://%s:%s\n", scheme, ip, port)
	}
	if !tlsEnabled {
		fmt.Println("  Aviso:  la geolocalización precisa requiere HTTPS fuera de localhost.")
	}
	fmt.Println()
}

func lanIPs() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}

	var ips []string
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok || ipNet.IP.IsLoopback() || ipNet.IP.To4() == nil {
			continue
		}
		ip := ipNet.IP.String()
		if strings.HasPrefix(ip, "169.254.") {
			continue
		}
		ips = append(ips, ip)
	}
	return ips
}
