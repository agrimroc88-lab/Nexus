# NEXUS

Sistema de gestión de Medicina Ocupacional y SG-SST para consultoría en Ecuador.

Marco normativo: **Decreto Ejecutivo 255 (2024)** y **Acuerdo Ministerial MDT-2024-196**.

App en vivo: https://agrimroc88-lab.github.io/Nexus/

---

## Índice

- [Arquitectura](#arquitectura)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Instalación](#instalación)
- [Base de datos](#base-de-datos)
- [Roles y seguridad](#roles-y-seguridad)
- [Módulos](#módulos)
- [Reglas de negocio](#reglas-de-negocio)
- [Marco normativo](#marco-normativo)
- [Diagnóstico de problemas](#diagnóstico-de-problemas)

---

## Arquitectura

**Restricción deliberada:** HTML5, CSS3, JavaScript Vanilla (ES6 Modules) y PostgreSQL
sobre Supabase. Nada más.

Sin React, sin Vue, sin Node, sin frameworks, sin librerías externas, sin APIs de terceros.
Los gráficos son SVG escrito a mano.

El objetivo no es la elegancia: es que el sistema siga funcionando en diez años sin
migrar nada. Una dependencia que se abandone obliga a reescribir lo que la usaba. El
navegador, en cambio, no rompe hacia atrás.

### Principios

| Principio | Qué significa |
|---|---|
| **Nunca duplicar datos** | Un dato se captura una vez y se lee donde haga falta. Dos copias divergen. |
| **Un módulo = 3 archivos** | Un HTML, un JS, un CSS. Los compartidos permanecen estables. |
| **La lógica vive en la base** | Las vistas agregan; el navegador solo pinta. La agregación en JS se repetiría y divergiría entre módulos. |
| **Derivar antes que declarar** | El estado se calcula de los hechos. Lo que el usuario declara, el usuario olvida actualizar. |
| **Multiaño** | Nunca se borra historia al cambiar de período. |

---

## Estructura del proyecto

```
Nexus/
├── index.html                  Redirección
├── login.html                  Autenticación
├── dashboard.html              Panel general · tablero de indicadores
├── empresas.html               Empresas → sucursales → áreas → cargos
├── trabajadores.html           Nómina y períodos laborales
├── atenciones.html             Atenciones médicas (morbilidad común)
├── farmacia.html               Medicamentos, lotes, kárdex
├── salud-ocupacional.html      Anexo 1 · ámbito salud
├── seguridad-industrial.html   Anexo 1 · ámbito seguridad
├── README.md
│
├── css/
│   ├── base.css                Variables + regla [hidden] crítica
│   ├── layout.css              Estructura de la aplicación
│   ├── empresas.css            Tablas, modales, botones (base compartida)
│   ├── trabajadores.css
│   ├── farmacia.css
│   ├── atenciones.css
│   ├── anexo1.css              Compartido por salud y seguridad
│   └── dashboard.css           Incluye estilos de impresión
│
├── js/
│   ├── supabase.js             Cliente único
│   ├── auth.js                 Sesión, roles, guardia de página
│   ├── nav.js                  Menú lateral + catálogo MODULOS
│   ├── utils.js                Validación RUC/cédula, formato, escapar, retrasar
│   ├── dashboard.js            Tablero + gráficos SVG
│   ├── empresas.js
│   ├── trabajadores.js
│   ├── atenciones.js
│   ├── farmacia.js
│   └── anexo1.js               Motor compartido · lee data-ambito del <body>
│
└── sql/
    ├── 001_tablas.sql
    ├── 002_trabajadores.sql
    ├── 003_farmacia.sql
    ├── 004_atenciones.sql
    ├── 005_anexo1.sql
    ├── 006_vigencia_evidencias.sql
    ├── 007_evidencias_seguridad.sql
    ├── 008_capacitaciones.sql
    ├── 009_eventos_sst.sql
    └── 010_tablero.sql
```

---

## Instalación

### 1. Base de datos

En Supabase → SQL Editor, ejecutar **en orden**:

```
001_tablas.sql
002_trabajadores.sql
003_farmacia.sql
004_atenciones.sql
005_anexo1.sql
006_vigencia_evidencias.sql
007_evidencias_seguridad.sql
008_capacitaciones.sql
009_eventos_sst.sql
010_tablero.sql
```

Todos son **reejecutables**: usan `IF NOT EXISTS` y `ON CONFLICT DO NOTHING`. Volver a
correrlos no destruye datos.

### 2. Usuario administrador

En Supabase → Authentication → Users → Add user. Luego insertar su perfil:

```sql
INSERT INTO perfiles (id, nombres, apellidos, cedula, rol)
VALUES ('<UID del usuario>', 'Nombre', 'Apellido', '0000000000', 'admin');
```

### 3. Publicación

GitHub Pages sobre la rama principal. La clave `anon` de Supabase es pública por diseño:
la seguridad la impone Row Level Security, no el secreto de la clave.

---

## Base de datos

### 001 · Fundación

`perfiles` · `empresas` → `sucursales` → `areas` → `cargos`

Incluye `fn_auditoria()` (trigger de creado/modificado en toda tabla), `rol_actual()` y
`tiene_permiso_clinico()`.

`rol_actual()` usa `SECURITY DEFINER` para evitar recursión infinita en las políticas RLS:
una política que consulta `perfiles` dispararía la política de `perfiles`, que consultaría
`perfiles`.

### 002 · Trabajadores

`trabajadores` · `periodos_laborales` · vista `v_trabajadores`

El código (1–3000) es permanente y único por empresa; jamás se recicla. La cédula es la
llave real. Los períodos laborales permiten reingresos sin duplicar la ficha.

Campos en `empresas`: `periodicidad_examen_meses` (12), `anticipacion_examen_meses` (2).

### 003 · Farmacia

`medicamentos` · `lotes` · `kardex` · vistas `v_stock_lotes`, `v_stock_medicamentos`

El saldo **nunca se almacena**: se calcula del kárdex. Un saldo guardado se desincroniza
del movimiento que lo produjo. El kárdex es inmutable — corregir un error exige un
movimiento de ajuste, no reescribir la historia.

Salida FEFO (primero en caducar, primero en salir). El lote se genera automáticamente
agrupando por medicamento + fecha de caducidad: el usuario nunca escribe número de lote.

### 004 · Atenciones médicas

`atenciones` · `atencion_diagnosticos` · `atencion_medicamentos` · `cie10` (182 códigos)
RPC `registrar_atencion()` · vistas `v_atenciones`, `v_morbilidad`

El primer diagnóstico (orden = 1) es el principal y define el caso en los indicadores.
Contar los secundarios inflaría el total.

### 005 · Anexo 1

`requisitos` (96) · `requisito_evidencias` · `cumplimientos` · `cumplimiento_enlaces`
RPC `abrir_cumplimientos()` · vistas `v_cumplimientos`, `v_indicadores_anexo1`,
`v_indicadores_consolidado`

Un solo catálogo para ambos ámbitos. El campo `ambito` (salud / seguridad / ambos)
determina qué módulo lo muestra.

| Ámbito | Requisitos |
|---|---|
| Salud | 20 propios |
| Seguridad | 73 propios |
| Compartidos | 3 (GT-06, GTH-09, GTH-10) |
| **Módulo Salud ve** | **23** |
| **Módulo Seguridad ve** | **76** |

Los compartidos generan **dos registros de cumplimiento**, uno por ámbito: la capacitación
de ergonomía del médico no puede tapar la falta de la charla de riesgo eléctrico del técnico.

### 006 · Vigencia por evidencia

Cada enlace tiene su propia fecha de registro y caducidad. La caducidad del requisito se
deriva: es la **más próxima** entre sus evidencias. Si el informe ergonómico vence en marzo
y el psicosocial en agosto, el requisito está vencido desde marzo.

### 007 · Evidencias múltiples de seguridad

POB-16 (plan + 2 cronogramas), POB-19 (programa + inventario), POB-21 (procedimiento +
matriz EPP), GTH-08 (programa + cronograma).

### 008 · Capacitaciones

`capacitacion_temas` · `capacitaciones` · RPC `abrir_capacitaciones()`

El **tema** persiste entre años; su **ejecución** pertenece a un año. En 2027 la lista de
temas sigue intacta, vacía de fechas y asistentes.

Cada tema activo **es** una evidencia esperada de GTH-09. Nueve temas de salud son nueve
espacios de enlace: subir cinco otorga 56% del requisito. El catálogo y el cumplimiento no
se declaran por separado — son la misma cosa vista desde dos lados.

Un trigger refleja el registro de asistencia en GTH-09 automáticamente: se captura una vez.

### 009 · Eventos SST

`eventos_sst` (seguridad) · `enfermedades_profesionales` (salud) ·
`atenciones_ocupacionales` (salud)

Granularidad deliberadamente distinta:

- **Eventos y enfermedades** se registran caso por caso. El área, el turno y los días de
  baja son propios de cada suceso; sin ellos no hay investigación ni índices.
- **Atenciones ocupacionales** son conteo mensual. Lo que se necesita es cuántos exámenes
  de cada tipo, no quién los recibió: el expediente individual ya vive en el módulo clínico.

### 010 · Tablero

Vistas `v_morbilidad_mensual`, `v_top_diagnosticos`, `v_indices_siniestralidad`,
`v_tablero_anual`, `v_serie_mensual`

Índices conforme **Resolución CD 513 (2016) Art. 56**:

```
Frecuencia = (accidentes × 200 000) / horas-hombre
Gravedad   = (días perdidos × 200 000) / horas-hombre
```

Las horas-hombre se **estiman** en 2 000 anuales por trabajador. Es una aproximación
declarada, no un dato medido: el índice oficial exige horas reales de planilla. El
documento impreso lo advierte al pie.

---

## Roles y seguridad

| Rol | Alcance |
|---|---|
| `admin` | Todo. Hereda permisos clínicos. |
| `medico_ocupacional` | Clínica completa + Anexo 1 ámbito salud |
| `tecnico_sst` | Anexo 1 ámbito seguridad + eventos. Sin acceso clínico. |
| `ergonomo` | Consulta + módulo de ergonomía (pendiente) |
| `consulta` | Solo lectura, sin datos clínicos |

**Secreto médico:** el técnico y el rol consulta nunca ven diagnósticos ni kárdex. La
enfermedad profesional, aunque sea información de gestión, contiene diagnóstico: solo el
médico y el administrador acceden.

**Escritura del Anexo 1 por ámbito:** el médico registra salud, el técnico seguridad, el
administrador ambos. Un ámbito no puede declarar el cumplimiento del otro. La política RLS
lo impone en la base; el JS solo lo espeja en la interfaz.

**Pendiente:** crear el rol `enfermeria`.

---

## Módulos

### Panel general

Tablero por empresa y año. Cumplimiento del Anexo 1 (salud, seguridad, total), cifras del
período, índices de siniestralidad, evolución mensual, top de morbilidad, capacitación.

Comparación entre años: cada cifra muestra su variación, con color según significado —
menos accidentes es verde, menos capacitaciones es rojo.

Botón **Imprimir**: sale a A4 vertical, fondo blanco, sin menú, con encabezado, fecha de
generación y saltos de página.

### Atenciones médicas

Morbilidad común. Tres pestañas:

- **Atenciones** — solo las de hoy. Mañana amanece vacía; todo queda guardado. Buscador
  arriba: código + Enter → ficha del paciente con dos botones (Nueva atención / Historial
  embebido).
- **Consolidado** — todas, filtrables por año, mes y diagnóstico. Da **nombres**.
- **Morbilidad** — ranking agregado por sexo. Da **números**.

### Farmacia

Medicamentos, lotes y kárdex inmutable. Saldo calculado, salida FEFO.

### Salud ocupacional / Seguridad industrial

**Un solo motor:** `anexo1.js`. El ámbito lo declara el HTML en `data-ambito`. Los dos
archivos se diferencian en cinco líneas.

Cuatro pestañas (la última solo en salud):

- **Cumplimiento** — requisitos del Anexo 1 con medidor, evidencias y vigencia
- **Capacitaciones** — catálogo multiaño ligado a GTH-09
- **Incidentes y accidentes** / **Enfermedades profesionales**
- **Atenciones ocupacionales** — matriz 12 meses × 4 tipos (solo salud)

---

## Reglas de negocio

### Trabajadores

- Un trabajador pertenece a **una** empresa. Otra empresa es otro expediente.
- Código 1–3000 permanente, nunca reciclado, se conserva en el reingreso.
- La antigüedad para el examen periódico se cuenta desde el **último** ingreso.
- Periódico anual; alerta a los 10 meses (ventana de programación).

### Farmacia

- El saldo se calcula del kárdex; nunca se almacena.
- Kárdex inmutable. Unidades mínimas, no cajas. FEFO.
- El lote se genera solo. El usuario escribe: medicamento, tipo, fecha, cantidad,
  caducidad, observación.

### Atenciones

- El primer diagnóstico es el principal y define el caso.
- Si falta stock, la atención se registra igual y el medicamento queda **no entregado**.
  Negar el registro por falta de inventario perdería el acto médico.
- Alergias en rojo, editables desde la atención, persistentes en la ficha.

### Anexo 1

- El estado **se deriva** de las evidencias. Solo "no aplica" es decisión humana.
- "No aplica" es **por empresa**, exige motivo escrito y sale de numerador **y**
  denominador. El porcentaje se mide sobre lo **exigible**.
- Cumplimiento **fraccionario**: un requisito con dos informes y uno entregado aporta 0,5.
- Los requisitos condicionados por número de trabajadores **se ocultan solos**
  (`min_trabajadores` / `max_trabajadores`). Nadie los configura.
- La evidencia es un **enlace**, no un archivo. El documento vive en su repositorio;
  duplicarlo genera versiones divergentes.
- Cada evidencia tiene su vigencia. La del requisito es la más próxima.

### Reparto de ámbitos

- **Accidentes de trabajo** → técnico (POB-06 a POB-10)
- **Enfermedades profesionales** → médico (POB-11, POB-12, POB-13)
- **Capacitaciones** → ambos, por separado. Mismo requisito legal, evidencias distintas.

### Capacitaciones

- Una al año, aunque tome varios días cubrir al personal (fecha de inicio y fin).
- El tema es global: se agrega a todas las empresas.
- Quitar un tema es **baja lógica**: sale de la lista y de GTH-09, pero los años cerrados
  conservan su registro.
- Salud viene con 9 temas precargados. Seguridad nace vacío: los define el técnico según
  los riesgos de cada operación.

### Multiaño

Todo el sistema conserva historia. Cambiar de año abre registros vacíos; nunca borra los
anteriores.

---

## Marco normativo

**Vigente:**

- Decreto Ejecutivo 255 (2024) — Reglamento del SG-SST
- Acuerdo Ministerial MDT-2024-196 — Anexo 1, lista de verificación
- Decisión 584 (2004) — Instrumento Andino de SST
- Resolución 957 (2008) — Reglamento del Instrumento Andino
- Resolución IESS CD 513 (2016) — Riesgos del trabajo
- Código del Trabajo (2005)

**Regla firme:** el **D.E. 2393 nunca se cita como ley vigente**. Fue derogado por el
D.E. 255. Citarlo en un documento técnico lo invalida.

---

## Diagnóstico de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| Los modales no cierran | `display:flex` anula el atributo `hidden` | La regla `[hidden]{display:none!important;}` en `base.css` lo resuelve. Verificar que exista. |
| El menú aparece duplicado | Se subió `nav (1).js` en vez de reemplazar `nav.js` | Renombrar en GitHub o editar con el lápiz. |
| "No existe la relación v_…" | Falta ejecutar un SQL | Correr los archivos de `sql/` en orden. |
| El módulo carga vacío | Los cumplimientos no se han abierto | Botón **Abrir requisitos** en la pestaña Cumplimiento. |
| No puedo escribir en el Anexo 1 | RLS por ámbito | El médico solo escribe salud; el técnico solo seguridad. |
| El porcentaje no cuadra | Hay requisitos en "no aplica" | Es correcto: salen del cálculo. El % se mide sobre lo exigible. |
| Los gráficos salen vacíos | Sin datos en el período | Verificar el año seleccionado. |
| Cambios de SQL sin efecto | Caché de esquema de Supabase | Esperar unos segundos o recargar el editor. |

### Al subir archivos a GitHub

El navegador renombra los archivos que ya existen: `nav.js` se convierte en `nav (1).js`.
Hay que renombrarlo antes de confirmar, o editar el original con el lápiz y pegar el
contenido. Este error ya rompió la navegación una vez.

---

## Autor

**Dr. Jorge Leonardo Arias Espinoza** — Médico ocupacional

Las reglas de negocio de este sistema provienen de la práctica de la medicina ocupacional
en Ecuador, no de una plantilla genérica de software.
