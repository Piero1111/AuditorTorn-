# Torn Bazaar Auto-Pricer

Userscript para Torn orientado a traders que utilizan TornW3B para administrar precios de compra.

## Funciones de la V1

- Botón flotante disponible en todas las páginas de Torn.
- Sincronización de la lista de precios desde TornW3B.
- Consulta de `/marketplace/{itemId}`.
- Estimación del valor real mediante listings actuales.
- Eliminación básica de outliers mediante IQR.
- Cálculo del porcentaje efectivo de compra de W3B comparando:
  - precio de compra W3B
  - MV de Torn
- Cálculo de compra recomendada aplicando ese porcentaje al valor real estimado.
- Cálculo de venta usando la mitad del descuento de compra.
- Histórico propio de observaciones.
- Auditor pasivo en segundo plano.
- Cola persistente para evitar repetir consultas innecesariamente.
- Resultados persistentes.
- Alertas 🔴 / 🟡 / 🟢.
- Búsqueda sin desplegar toda la lista al tocar el campo.
- Sugerencias a partir de 2 caracteres.
- Copiar precio de compra y venta.
- Protección contra creación duplicada del botón flotante.

## Estructura

```text
Torn-Bazaar-AutoPricer/
├── TornBazaarAutoPricer.user.js
├── README.md
└── CHANGELOG.md
```

## Instalación

1. Crea un repositorio en GitHub.
2. Sube los tres archivos.
3. Abre `TornBazaarAutoPricer.user.js` desde la vista Raw de GitHub.
4. Instálalo con Tampermonkey/Violentmonkey/PDA según el entorno que utilices.
5. En el script, sustituye `TU_USUARIO` de `@updateURL` y `@downloadURL` por tu usuario de GitHub.
6. Introduce tu Torn API Key y Torn ID desde ⚙️/el panel del script.

## Actualizaciones

El encabezado del userscript contiene `@updateURL` y `@downloadURL`.

Cuando se publique una nueva versión:

1. Cambia `@version`.
2. Sube el archivo actualizado a GitHub.
3. El gestor de userscripts podrá detectar la nueva versión.

## Datos

La configuración, lista sincronizada, resultados e histórico se almacenan localmente mediante `GM_setValue`/`GM_getValue`.

El repositorio no necesita almacenar API keys ni datos personales.

## Nota

La estimación de valor real de esta V1 es deliberadamente conservadora. No sustituye todavía un histórico de mercado completo; el histórico propio se construye progresivamente con las observaciones realizadas por el auditor.
