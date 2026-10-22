Sos un preparador físico. Armame una rutina de entrenamiento y devolvela **solo** como un JSON válido, en el formato exacto de abajo, para cargarla en la app Treino.

## Mis datos
- Objetivo: <ej. ganar fuerza, volver a correr, mantenerme>
- Nivel y experiencia: <principiante / intermedio / avanzado, qué hacés hoy>
- Lesiones o molestias: <ninguna / cuáles>
- Días disponibles: <ej. lunes, miércoles y viernes>
- Tiempo por sesión: <ej. 60 minutos>
- Dónde entreno: <gimnasio con máquinas / casa / plaza o pista>
- Fecha de inicio: <AAAA-MM-DD> · Duración: <ej. 4 semanas>

## Ejercicios disponibles
Usá **solo** estos ejercicios, con el `name` exacto y su `ex` (id). Si necesitás uno que no está, usalo igual con un `name` claro y sin `ex`. La app lo muestra igual, pero sin video.

{{CATALOGO}}

## Formato (respetalo al pie de la letra)
```json
{
  "version": 1,
  "name": "Nombre corto de la rutina",
  "days": [
    { "date": "AAAA-MM-DD", "items": [
      { "id": "gym-AAAA-MM-DD", "type": "gym", "title": "Tren inferior",
        "exercises": [
          { "ex": "hip-thrust", "name": "Hip thrust", "sets": 3, "reps": 10, "weight": 40 },
          { "ex": "plancha-lateral", "name": "Plancha lateral", "sets": 3, "time": "30s", "per_side": true }
        ] },
      { "id": "run-AAAA-MM-DD", "type": "run", "title": "Intervalos",
        "steps": [
          { "ex": "caminar", "do": "Caminar", "time": "5min" },
          { "repeat": 6, "steps": [ { "ex": "trote", "do": "Trote", "time": "2min" }, { "ex": "caminar", "do": "Caminar", "time": "1min" } ] }
        ] }
    ] }
  ]
}
```

Reglas:
- `type`: `gym` (gimnasio), `run` (trote o carrera) o `field` (campo: técnica, velocidad, agilidad). `check` sirve para algo que solo se tilda, como una clase o la kinesiología.
- Cada item tiene `id`, único en todo el archivo, sin espacios, que no empiece con "_" y sin "|". Usá el tipo y la fecha, y agregá un sufijo si hay dos del mismo tipo el mismo día.
- Las fechas van en formato AAAA-MM-DD, ordenadas y sin repetir. Un día que no aparece es descanso.
- En gimnasio, cada ejercicio lleva `sets` y `reps` (un número o un rango como "8-10") o `time` (como "30s"). `weight` va en kg y es opcional. `per_side: true` indica que es por cada lado.
- En `run` y `field`, cada paso lleva `do` y `time` o `distance`. Opcionales: `reps`, `sets`, `intensity` (como "70%") y `pace`. Las repeticiones van en un bloque `repeat` con sus `steps`, y no se pone un `repeat` dentro de otro.
- No pongas dos sesiones con impacto (trote o campo) en días seguidos si soy principiante o tengo una lesión.
- Opcional en cualquier item: `notes`, con una indicación corta.

Devolvé únicamente el JSON, sin explicaciones antes ni después.
