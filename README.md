# Treino

PWA personal: muestra qué toca hoy según la rutina (JSON por fechas) y registra gym, trote/campo, kinesio, partidos y el chequeo de la mañana. Funciona sin señal y sincroniza con Supabase. Sin build: HTML + JS servidos por GitHub Pages.

## Puesta en marcha
1. Supabase → nuevo proyecto → **SQL Editor**: pegar y correr `supabase/schema.sql`.
2. **Authentication → Sign In / Providers**: desactivar "Allow new users to sign up". **Authentication → Users → Add user**: tu email + contraseña ("Auto Confirm").
3. **Project Settings → API**: copiar URL y anon/publishable key a `config.js`.
4. GitHub Pages sirve la rama `main` (raíz). URL: `https://<usuario>.github.io/Treino/`.
5. En el móvil (Chrome): abrir la URL → menú → "Agregar a pantalla principal".

## Flujo mensual
Rutina → pestaña **Rutina → Cargar rutina nueva** (archivo o pegar). Reemplaza la vigente; los registros se guardan por fecha + id de item y se conservan.
Para reajustar: **Exportar lo hecho** → pegar en Claude con un comentario → cargar la rutina que devuelve.

Las rutinas y los exports tienen datos de salud: no se suben a este repo (`.gitignore`).

## Tests
`npm test` (lógica de `plan.js`: validación, progreso, análisis, export).
