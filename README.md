# AuditorTorn

Userscript para Torn orientado a traders que utilizan TornW3B para administrar precios.

## V1.0.1

Esta versión corrige la interfaz de la V1:

- La búsqueda puede consultar un artículo inmediatamente si todavía no tiene resultado guardado.
- Si el resultado existe pero está viejo, se muestra primero y se actualiza en segundo plano.
- API Key y Torn ID pasan a **Configuración (⚙️)**.
- La sincronización W3B también está dentro de Configuración.
- Se añade **Historial (📈)**.
- Abrir Auditor no vuelve a auditar todos los artículos.
- El botón flotante sigue siendo global y se evita duplicarlo.
- Las sugerencias de búsqueda solo aparecen desde 2 caracteres.
- El auditor pasivo continúa funcionando en segundo plano.

## Archivos

```text
AuditorTorn.user.js
README.md
CHANGELOG.md
```

## Instalación / actualización

Remote URL:

`https://raw.githubusercontent.com/Piero1111/AuditorTorn-/main/AuditorTorn.user.js`

Al publicar una nueva versión, aumenta `@version` en el userscript y reemplaza el archivo del repositorio.

## Datos locales

La API Key, Torn ID, lista W3B, resultados e histórico se almacenan localmente mediante `GM_setValue`/`GM_getValue`. No deben subirse al repositorio.

## Modelo actual

1. Se obtiene el precio de compra configurado en W3B.
2. Se compara con el MV de Torn para obtener el porcentaje efectivo.
3. Se consulta `/marketplace/{itemId}`.
4. Se estima el valor real usando los listings actuales y un filtro básico de outliers.
5. Se aplica el porcentaje efectivo al valor real para obtener la compra recomendada.
6. Se utiliza la mitad del descuento de compra para calcular la venta recomendada.
7. Cada auditoría agrega una observación al histórico propio.
