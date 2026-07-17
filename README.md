# NEXUS

**Sistema Inteligente de Medicina Ocupacional y Seguridad y Salud en el Trabajo**

Sistema web para la gestión de medicina ocupacional y SG-SST bajo normativa ecuatoriana.
No es un CRUD: relaciona información, calcula estados y genera alertas para asistir la
decisión del médico ocupacional.

- **Aplicación:** https://agrimroc88-lab.github.io/Nexus/
- **Responsable:** Dr. Jorge Leonardo Arias Espinoza · Médico Ocupacional
- **Marco legal:** D.E. 255 (2024), A.M. MDT-2024-196

---

## Arquitectura

Restricción deliberada: sin frameworks, sin librerías, sin dependencias externas.
El sistema debe seguir funcionando dentro de diez años sin migrar nada.

| Capa | Tecnología |
|---|---|
| Alojamiento | GitHub Pages |
| Interfaz | HTML5, CSS3, JavaScript Vanilla (ES6 Modules) |
| Datos | PostgreSQL vía Supabase |
| Autenticación | Supabase Auth |
| Seguridad | Row Level Security (RLS) |

**Prohibido:** React, Vue, Angular, Node, Express, Firebase, MongoDB, MySQL,
Docker, frameworks CSS, APIs externas.

### Proyecto Supabase

```
URL: https://ydqwkxpkjwydxownwapv.supabase.co
```

La clave `anon` es pública por diseño y reside en `js/supabase.js`. La seguridad
real la impone RLS en PostgreSQL, no el ocultamiento de la clave.
La clave `service_role` nunca debe incorporarse al repositorio.

---

## Organización

```
/
├── index.html              Portada
├── login.html              Acceso
├── dashboard.html          Panel general
├── empresas.html           Módulo Empresas
├── trabajadores.html       Módulo Trabajadores
├── farmacia.html           Módulo Farmacia
│
├── css/
│   ├── base.css            Variables, reset, tipografía      [COMPARTIDO]
│   ├── layout.css          Shell: lateral, cabecera          [COMPARTIDO]
│   ├── login.css
│   ├── dashboard.css
│   ├── empresas.css        Tabla, modal, botones, formulario
│   ├── trabajadores.css
│   └── farmacia.css
│
├── js/
│   ├── supabase.js         Cliente único de conexión         [COMPARTIDO]
│   ├── auth.js             Sesión, roles, guardia de rutas   [COMPARTIDO]
│   ├── nav.js              Barra lateral y catálogo módulos  [COMPARTIDO]
│   ├── utils.js            Validación, formato, reglas       [COMPARTIDO]
│   ├── login.js
│   ├── dashboard.js
│   ├── empresas.js
│   ├── trabajadores.js
│   └── farmacia.js
│
├── img/
└── sql/
    ├── 001_tablas.sql      Perfiles, empresas, estructura
    ├── 002_trabajadores.sql
    └── 003_farmacia.sql
```

### Regla de aislamiento

**Un módulo = un HTML + un JS + un CSS.** Ningún módulo modifica archivos de otro.

- Cero `<script>` embebido. Cero `onclick=` en el marcado.
- Cero `<style>` embebido. Cero `style=` en línea.
- Los cinco archivos marcados `[COMPARTIDO]` son estables por diseño.
  Modificarlos exige advertir el impacto antes.

`empresas.css` contiene los estilos genéricos de tabla, modal, formulario y botones.
Otros módulos lo importan y añaden solo lo propio. No es deuda técnica: es
reutilización deliberada.

---

## Roles

| Rol | Alcance |
|---|---|
| `admin` | Control total. **Hereda todos los permisos clínicos.** |
| `medico_ocupacional` | Historia clínica, exámenes, aptitud, vigilancia, farmacia |
| `tecnico_sst` | Riesgos, inspecciones, estructura organizacional. **Sin acceso clínico** |
| `ergonomo` | Evaluaciones ergonómicas |
| `consulta` | Solo lectura, sin datos clínicos |

**Decisión de diseño:** `admin` no es paralelo al médico; lo contiene. El titular
del sistema es médico ocupacional y administrador a la vez, sin cambiar de contexto.

**Secreto médico:** `tecnico_sst` y `consulta` nunca acceden a diagnósticos,
resultados ni al kárdex de dispensación. Solo al certificado de aptitud y las
restricciones operativas — lo que el empleador legalmente necesita conocer.
Esto se impone por RLS a nivel de tabla, no ocultando botones.

**Pendiente:** rol `enfermeria` para el personal que opera farmacia y atenciones.
Al crearse, se añade a las políticas RLS de `medicamentos`, `lotes` y `kardex`.

---

## Modelo de datos

```
empresas
   └── sucursales
          └── areas
                 └── cargos ──────────┐
                                      │
trabajadores (por empresa)            │
   └── periodos_laborales ────────────┘
                 │
                 ↓
medicamentos → lotes → kardex ← trabajadores
```

### Cadena conceptual del sistema

```
Empresa → Sucursal → Área → Cargo → Factores de Riesgo → Protocolos
   → Exámenes → Resultados → Aptitud → Restricciones
   → Vigilancia → Indicadores → Reportes
```

El **cargo** es el nodo central: de él cuelgan los riesgos que determinan
qué exámenes corresponden. Ningún módulo debe diseñarse aislado de esta cadena.

---

## Reglas de negocio

### Trabajadores

**Pertenencia por empresa.** El trabajador pertenece a una sola empresa.
El mismo individuo en otra empresa cliente constituye un expediente
independiente, con otro código y otro historial. Los expedientes no se cruzan.
Esto evita mezclar historias clínicas entre empleadores.

**Código permanente.** Entero de 1 a 3000, único por empresa. Se asigna una vez
y **jamás se recicla**. Si el trabajador sale, el código queda reservado; si
reingresa, vuelve con el mismo. Reasignarlo mezclaría historias clínicas de dos
personas: el peor error posible en medicina ocupacional.

El sistema **sugiere** el menor código libre pero no lo impone: existen códigos
históricos previos al sistema y el usuario debe poder respetarlos.

**La cédula es la llave real.** El código es etiqueta interna; la cédula
identifica a la persona. `UNIQUE (empresa_id, cedula)` impide duplicados.
Al escribir una cédula ya registrada e inactiva, el sistema detecta y ofrece
reingreso en lugar de crear un registro nuevo.

**Reingreso.** Genera un periodo laboral nuevo. El cargo puede cambiar;
el código nunca.

**Nunca se borra.** Solo se desactiva. `trabajadores.activo` es un campo
derivado, mantenido por trigger: verdadero si existe un periodo sin fecha
de salida. Nunca se escribe a mano.

**Un solo periodo abierto.** Índice único parcial en la base:
`WHERE fecha_salida IS NULL`. No depende de que la interfaz lo valide.

### Antigüedad y examen periódico

**La antigüedad se cuenta desde el último ingreso, no desde el primero.**

Un trabajador con diez años previos que estuvo cinco años fuera y reingresa
vuelve con cero meses. Fundamento clínico: lo que importa es el tiempo de
**exposición continua** al riesgo actual. La interrupción resetea la exposición.

**Periodicidad: 12 meses. Alerta: 10 meses.**

El examen periódico es anual. Los 10 meses son la **ventana de programación
anticipada**, no la obligación. Se programa a los 10 meses para que el examen
se realice antes de cumplir el año: agendar, laboratorio y resultados consumen
tiempo, y esperar al mes 12 empujaría el examen al mes 13 o 14, dejando al
trabajador descubierto.

| Estado | Condición |
|---|---|
| `al_dia` | Menos de 10 meses |
| `por_programar` | 10 a 12 meses — ventana de gestión |
| `vencido` | Más de 12 meses — incumplimiento |

Ambos valores son configurables por empresa (`empresas.periodicidad_examen_meses`,
`empresas.anticipacion_examen_meses`) aunque el formulario no los expone. Existen
para que un requerimiento contractual futuro no obligue a reescribir el módulo.

**No se realizan exámenes semestrales.** Periodicidad anual para toda empresa.

### Edad

Nunca se almacena; se calcula desde `fecha_nacimiento`. Un dato almacenado
envejece mal, literalmente.

### Farmacia

**El saldo nunca se almacena.** Se calcula como suma algebraica del kárdex.
Un kárdex es un libro de movimientos, no un contador. Almacenar el saldo
permitiría que un error lo corrompiera de forma permanente, sin auditoría posible.

**El kárdex es inmutable.** Trigger `fn_kardex_inmutable()` bloquea `UPDATE`
y `DELETE`. Un error se corrige registrando un movimiento contrario. La
trazabilidad es innegociable.

**Toda existencia pertenece a un lote con caducidad.** No se registra stock
sin lote. Exigencia sanitaria y garantía de que no se dispense vencido.

**Unidad mínima de dispensación.** Una caja de 100 tabletas se registra como
100 tabletas. El consumo se da por tableta; contar cajas haría mentir al stock.
El campo `presentacion` es referencia informativa y no participa en cálculos.

**La salida por consumo exige trabajador identificado.** Restricción en la base:
`CHECK (tipo <> 'salida_consumo' OR trabajador_id IS NOT NULL)`.
Las bajas y ajustes no lo exigen.

**FEFO** — *First Expired, First Out*. Al dispensar, el sistema preselecciona
el lote con caducidad más próxima. Evita que se venza medicación al fondo
del botiquín.

**Niveles de existencia:**

| Campo | Uso |
|---|---|
| `stock_minimo` | Punto de reposición. Por debajo → alerta |
| `stock_optimo` | Meta. `reponer = optimo − disponible` |
| `stock_maximo` | Techo. Evita sobrestock que caduca sin usarse |

Definición manual por criterio del médico. Con 3–6 meses de kárdex acumulado
podrá añadirse sugerencia automática por consumo histórico sin alterar la
estructura: los datos ya estarán ahí.

**Stock total ≠ stock disponible.** Los lotes caducados suman al total pero
no son dispensables. La interfaz muestra ambos.

**Tipos de movimiento:**

| Tipo | Signo | Notas |
|---|---|---|
| `inventario_inicial` | + | Conteo al implantar el sistema |
| `entrada_compra` | + | Reposición |
| `entrada_donacion` | + | Sin costo |
| `salida_consumo` | − | **Exige trabajador** |
| `ajuste_positivo` | + | Conteo físico: sobra |
| `ajuste_negativo` | − | Conteo físico: falta |
| `baja_caducidad` | − | Vencido |
| `baja_deterioro` | − | Dañado o perdido |

La función `signo_movimiento()` es el punto único de verdad sobre qué suma
y qué resta. No duplicar esa lógica en ningún otro lugar.

**Validaciones impuestas por la base** (trigger `fn_validar_movimiento`):
- Prohibido dispensar lote caducado
- Prohibido ingresar lote ya vencido
- Saldo nunca negativo
- Coherencia empresa ↔ medicamento ↔ lote ↔ trabajador

### Empresas

**RUC validado** con algoritmo ecuatoriano completo: módulo 10 para persona
natural, módulo 11 para sociedad privada y sector público. Un RUC inválido
no entra a la base.

**El RUC no se edita** una vez creado: es la identidad legal del registro.

**Alerta legal automática** según número de trabajadores:

| Trabajadores | Obligación |
|---|---|
| 1–9 | Responsable de SST designado |
| 10–49 | **Delegado de SST obligatorio** (Art. 33, D.E. 255) |
| 50–99 | Técnico de SST y Comité Paritario |
| 100+ | Unidad de SST, Comité Paritario y Servicio Médico |

**Nunca se borra.** Solo se desactiva. El histórico es permanente en
documentación de SST.

---

## Convenciones

### Base de datos

- Auditoría en toda tabla: `creado_en`, `creado_por`, `modificado_en`, `modificado_por`,
  mantenida por trigger `fn_auditoria()`. Nunca a mano.
- `rol_actual()` usa `SECURITY DEFINER` para evitar recursión infinita en políticas
  RLS — error clásico de Supabase.
- Los campos derivados se mantienen por trigger, jamás por la interfaz.
- Las vistas (`v_`) calculan; las tablas almacenan hechos.

### JavaScript

- ES6 Modules. Cada archivo declara qué importa y qué exporta.
- Todo texto proveniente de la base pasa por `escapar()` antes de inyectarse en HTML.
- La validación en la interfaz es cortesía; la validación real está en la base.
- Español en nombres de funciones, variables y comentarios.

### CSS

- Variables en `:root` dentro de `base.css`. No introducir colores sueltos.
- `[hidden] { display: none !important; }` en `base.css`: sin esa regla,
  `display: flex` de los modales anula el atributo `hidden` y las ventanas
  no cierran. Defecto ya corregido; no reintroducirlo.

---

## Estado

### Operativo

- Autenticación, sesión y guardia de rutas
- Roles y RLS
- Panel general con indicadores
- **Empresas** — alta, edición, desactivación, validación de RUC, alerta legal
- **Trabajadores** — código permanente, historial de periodos, reingreso
  automático, semáforo de periódico
- **Farmacia** — catálogo, lotes, kárdex, FEFO, alertas de caducidad y
  reposición, baja de caducados

### Pendiente

**Inmediato**
- Módulo de estructura organizacional: Sucursales → Áreas → Cargos.
  Sin él no se puede asignar cargo a un trabajador.
- Rol `enfermeria` y gestión de usuarios.

**Siguiente**
- Enfermería · Atenciones. La salida de farmacia debe nacer de una atención.
- Factores de riesgo por cargo (metodología GTC 45).
- Protocolos de exámenes según cargo, riesgo y actividad económica.
- Exámenes ocupacionales: preocupacional, periódico, reintegro, retiro,
  especial, cambio de puesto. El sistema **sugiere**; el médico decide.
- Historia clínica ocupacional: nunca sobrescribir, todo conserva historial.
- Vigilancia de la salud: comparar resultados, detectar tendencias, alertar.
- Ergonomía: ROSA, RULA, REBA, MAC, NIOSH, OCRA. No almacenar solo
  puntuaciones — interpretar y recomendar.
- Inspecciones: fotografías, hallazgos, planes de acción, seguimiento, cierre.
- Indicadores y reportes: PDF, Excel, tablero.

---

## Operación

### Publicar cambios

Los archivos se editan en GitHub (icono de lápiz) o se suben con
`Add file → Upload files`. GitHub Pages publica automáticamente en 1–2 minutos.

**Advertencia:** al subir un archivo que ya existe, el navegador puede
renombrarlo como `archivo (1).js`. GitHub lo tratará como archivo nuevo y el
original quedará intacto. Renombrar antes de subir, o editar directamente
con el lápiz.

Con el crecimiento del proyecto conviene migrar a GitHub Desktop + VS Code.

### Ejecutar SQL

Supabase → SQL Editor → New query → pegar el archivo completo → Run.
Los scripts usan `IF NOT EXISTS` y `DROP ... IF EXISTS`: son reejecutables
sin destruir datos.

### Diagnóstico

F12 → Console. Errores frecuentes:

| Síntoma | Causa probable |
|---|---|
| 404 en `css/` o `js/` | Archivos no subidos o en subcarpeta equivocada |
| Módulo no responde | Archivo `(1)` duplicado; el original quedó desactualizado |
| Modal no cierra | Falta `[hidden] { display: none !important; }` |
| `relation does not exist` | El SQL correspondiente no se ejecutó |
| 409 al guardar | Violación de restricción única |
| Recursión infinita en RLS | Función de rol sin `SECURITY DEFINER` |

---

## Filosofía

> No quiero el software más rápido. Quiero el software mejor diseñado.

Antes de escribir código: analizar el problema, la lógica del negocio, el
impacto sobre el sistema; diseñar; explicar la estrategia. Después, codificar.

Antes de crear una tabla: analizar relaciones, dependencias, impacto,
escalabilidad. Antes de crear una función: verificar si ya existe algo
reutilizable. Antes de crear un módulo: analizar cómo afecta a los demás.

Ante un error: no reconstruir. Analizar, identificar la causa, explicar,
corregir únicamente lo necesario.

El sistema debe pensar como arquitecto, como médico ocupacional, como
especialista en ergonomía. Debe pensar en la normativa ecuatoriana, en la
escalabilidad, en la integridad de la información y en quien lo usa.

**El médico siempre tiene la decisión final.** El sistema sugiere, alerta,
relaciona y calcula. No impone.
