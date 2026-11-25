package main

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testHandler(t *testing.T) http.Handler {
	t.Helper()
	web, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		t.Fatalf("no se pudo montar web: %v", err)
	}
	return newHandler(web)
}

func TestIndexServesApp(t *testing.T) {
	handler := testHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("código = %d, esperado 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content-type = %q, esperado text/html", ct)
	}
	if !strings.Contains(rec.Body.String(), "ubícate") {
		t.Fatal("la portada no contiene el nombre de la aplicación")
	}
	if rec.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("falta la cabecera Content-Security-Policy")
	}
}

func TestHealth(t *testing.T) {
	handler := testHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("código = %d, esperado 200", rec.Code)
	}

	var body healthResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("respuesta JSON inválida: %v", err)
	}
	if body.Status != "ok" || body.Service != "ubicate" || body.Version == "" {
		t.Fatalf("respuesta inesperada: %+v", body)
	}
}

func TestHealthRejectsPost(t *testing.T) {
	handler := testHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("código = %d, esperado 405", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); allow != http.MethodGet {
		t.Fatalf("Allow = %q, esperado GET", allow)
	}
}

func TestStaticAsset(t *testing.T) {
	handler := testHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/js/app.js", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("código = %d, esperado 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("content-type = %q, esperado javascript", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc == "" {
		t.Fatal("falta Cache-Control")
	}
}

func TestManifestContentType(t *testing.T) {
	handler := testHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/manifest.webmanifest", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("código = %d, esperado 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/manifest+json") {
		t.Fatalf("content-type = %q, esperado application/manifest+json", ct)
	}
}

func TestUnknownRoute(t *testing.T) {
	handler := testHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/no-existe", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("código = %d, esperado 404", rec.Code)
	}
}

func TestPathTraversalBlocked(t *testing.T) {
	web, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		t.Fatalf("no se pudo montar web: %v", err)
	}
	s := &server{web: web}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.URL.Path = "/../main.go"
	rec := httptest.NewRecorder()

	s.handleStatic(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("código = %d, esperado 404", rec.Code)
	}
}

func TestHeadRequest(t *testing.T) {
	handler := testHandler(t)
	req := httptest.NewRequest(http.MethodHead, "/css/styles.css", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("código = %d, esperado 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD devolvió %d bytes de cuerpo", rec.Body.Len())
	}
}
