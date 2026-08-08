# Auditor Torn

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
AuditorTorn/
├── AuditorTorn.user.js
├── README.md
└── CHANGELOG.md
```



## Nota

La estimación de valor real de esta V1 es deliberadamente conservadora. No sustituye todavía un histórico de mercado completo; el histórico propio se construye progresivamente con las observaciones realizadas por el auditor.
