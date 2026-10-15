// =====================================================================
// NEXUS LEARNING · CERTIFICADO EN PDF
// Carpeta: js/certificado.js
// Dibuja el certificado (A4 horizontal) con código QR de verificación.
// Para cambiar el diseño del certificado, solo se edita este archivo.
// Requiere: jsPDF y qrcode-generator (se cargan en curso.html).
// =====================================================================

const NexusCertificado = (function () {
  const PINO = [18, 58, 122];
  const PINO_CLARO = [31, 85, 168];
  const SENAL = [227, 179, 65];
  const TINTA = [20, 32, 58];
  const GRIS = [85, 98, 122];

  function urlVerificacion(codigo) {
    const base = location.origin + location.pathname.replace(/[^/]*$/, "");
    return base + "verificar.html?codigo=" + encodeURIComponent(codigo);
  }

  function fechaLarga(valor) {
    const d = valor ? new Date(valor) : new Date();
    return d.toLocaleDateString("es-EC", { day: "numeric", month: "long", year: "numeric" });
  }

  function texto(doc, contenido, x, y, opciones) {
    const o = Object.assign({ tam: 12, color: TINTA, estilo: "normal", alinear: "center" }, opciones);
    doc.setFont("helvetica", o.estilo);
    doc.setFontSize(o.tam);
    doc.setTextColor(o.color[0], o.color[1], o.color[2]);
    doc.text(contenido, x, y, { align: o.alinear });
  }

  // Dibuja el QR con cuadrados (no necesita imágenes)
  function dibujarQR(doc, contenido, x, y, tamano) {
    const qr = qrcode(0, "M");
    qr.addData(contenido);
    qr.make();
    const n = qr.getModuleCount();
    const celda = tamano / n;
    doc.setFillColor(255, 255, 255);
    doc.rect(x - 2, y - 2, tamano + 4, tamano + 4, "F");
    doc.setFillColor(TINTA[0], TINTA[1], TINTA[2]);
    for (let fila = 0; fila < n; fila++) {
      for (let col = 0; col < n; col++) {
        if (qr.isDark(fila, col)) {
          doc.rect(x + col * celda, y + fila * celda, celda + 0.02, celda + 0.02, "F");
        }
      }
    }
  }

  // Texto centrado en varias líneas; devuelve la "y" de la última línea
  function parrafo(doc, contenido, x, y, ancho, tam, alto) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(tam);
    doc.setTextColor(GRIS[0], GRIS[1], GRIS[2]);
    const lineas = doc.splitTextToSize(contenido, ancho).slice(0, 3);
    lineas.forEach(function (l, i) { doc.text(l, x, y + i * alto, { align: "center" }); });
    return y + (lineas.length - 1) * alto;
  }

  function horasTexto(h) {
    const n = Number(h) || 0;
    return n === 1 ? "1 hora" : n.toLocaleString("es-EC") + " horas";
  }

  function fechaCorta(iso) {
    // "2026-10-10" como fecha local (sin correr un día por la zona horaria)
    const p = String(iso).split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
      .toLocaleDateString("es-EC", { day: "numeric", month: "long", year: "numeric" });
  }

  // Frase que describe cómo se realizó y con qué resultado
  function descripcion(d, esAsistencia) {
    const partes = [];
    partes.push((esAsistencia ? "Capacitación desarrollada" : "Curso desarrollado") +
      (d.modalidad ? " en modalidad " + d.modalidad : ""));
    if (d.fecha_capacitacion) partes.push("el " + fechaCorta(d.fecha_capacitacion));
    partes.push("con una duración de " + horasTexto(d.horas));
    let frase = partes.join(", ");
    if (!esAsistencia && d.nota !== null && d.nota !== undefined) {
      frase += ", habiendo aprobado la evaluación de conocimientos con una calificación de " +
        Number(d.nota).toLocaleString("es-EC", { maximumFractionDigits: 1 }) + " %";
    }
    return frase + ", como parte del programa de formación en Seguridad y Salud en el Trabajo.";
  }

  // Lista de subtemas: en una línea si son pocos; en dos columnas si son más.
  // Respeta el espacio de la firma y del código QR.
  function contenidos(doc, temas, cx, y, limite, anchoCol, anchoLinea) {
    texto(doc, "Contenidos desarrollados", cx, y + 4, { tam: 10, estilo: "bold", color: PINO });
    let yy = y + 10;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(TINTA[0], TINTA[1], TINTA[2]);

    if (temas.length <= 3) {
      doc.splitTextToSize(temas.join("  •  "), anchoLinea).slice(0, 2).forEach(function (l, i) {
        doc.text(l, cx, yy + i * 4.6, { align: "center" });
      });
      return;
    }

    const x1 = cx - anchoCol - 2, x2 = cx + 4;   // la 2.ª columna termina antes del QR
    const filas = Math.max(1, Math.floor((limite - yy) / 4.6) + 1);
    let lista = temas.slice();
    if (lista.length > filas * 2) {
      lista = lista.slice(0, filas * 2 - 1);
      lista.push("Otros temas del programa");
    }
    const porColumna = Math.ceil(lista.length / 2);
    lista.forEach(function (t, i) {
      const x = i < porColumna ? x1 : x2;
      const fila = i < porColumna ? i : i - porColumna;
      let linea = doc.splitTextToSize(t, anchoCol - 5)[0];
      if (linea.length < t.length) linea = linea.replace(/\s*\S*$/, "") + "…";
      doc.setFillColor(SENAL[0], SENAL[1], SENAL[2]);
      doc.circle(x + 1.2, yy + fila * 4.6 - 1.1, 0.8, "F");
      doc.text(linea, x + 4, yy + fila * 4.6);
    });
  }

  // Logo de Nexus Learning (img/logo-certificado.png), precargado como imagen
  let logo = null;
  (function () {
    const im = new Image();
    im.onload = function () {
      try {
        const c = document.createElement("canvas");
        c.width = im.naturalWidth; c.height = im.naturalHeight;
        c.getContext("2d").drawImage(im, 0, 0);
        logo = { datos: c.toDataURL("image/png"), prop: im.naturalWidth / im.naturalHeight };
      } catch (e) { logo = null; }
    };
    im.src = "img/logo-certificado.png";
  })();

  // Dibuja el logo con alto "h" desde (x, y); devuelve su ancho
  function marca(doc, x, y, h) {
    if (logo) {
      doc.addImage(logo.datos, "PNG", x, y, h * logo.prop, h, "logo", "FAST");
      return h * logo.prop;
    }
    const cy = y + h / 2, r = h / 6;           // respaldo: los dos círculos
    doc.setFillColor(SENAL[0], SENAL[1], SENAL[2]);
    doc.circle(x + r, cy, r, "F");
    doc.setDrawColor(SENAL[0], SENAL[1], SENAL[2]);
    doc.setLineWidth(1.4);
    doc.circle(x + r * 3.4, cy, r, "S");
    return r * 4.4;
  }

  // --- Fondo y marca: triángulos azules y dorados en las esquinas ---
  function fondo(doc, W, H) {
    doc.setFillColor(SENAL[0], SENAL[1], SENAL[2]);
    doc.triangle(W - 84, 0, W, 0, W, 54, "F");
    doc.triangle(0, H - 54, 0, H, 84, H, "F");
    doc.setFillColor(PINO[0], PINO[1], PINO[2]);
    doc.triangle(W - 76, 0, W, 0, W, 49, "F");
    doc.triangle(0, H - 49, 0, H, 76, H, "F");
    doc.setFillColor(PINO_CLARO[0], PINO_CLARO[1], PINO_CLARO[2]);
    doc.triangle(W - 40, 0, W, 0, W, 26, "F");
    doc.triangle(0, H - 26, 0, H, 40, H, "F");
    const w = marca(doc, 20, 16, 24);
    texto(doc, "NEXUS LEARNING", 23 + w, 27, { tam: 14, estilo: "bold", color: PINO, alinear: "left" });
    doc.setFillColor(SENAL[0], SENAL[1], SENAL[2]);
    doc.rect(23 + w, 30, 22, 1.2, "F");
    texto(doc, "Formación en Seguridad y Salud", 23 + w, 36, { tam: 8.5, color: GRIS, alinear: "left" });
    return { cx: W / 2, dy: 2, curso: 220, desc: 225, linea: 85, firma: 72, fecha: W / 2, qr: 238, limite: 165, col: 84 };
  }


  function generar(d) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const W = 297, H = 210;

    // --- Fondo y marca ---
    const L = fondo(doc, W, H);
    const CX = L.cx, Y = L.dy;

    const esAsistencia = d.tipo === "asistencia";

    // --- Título ---
    texto(doc, esAsistencia ? "Certificado de asistencia" : "Certificado de aprobación", CX, 47 + Y, { tam: 28, estilo: "bold", color: PINO });
    texto(doc, "Se certifica que", CX, 57 + Y, { tam: 12, color: GRIS });

    // --- Nombre ---
    const nombre = String(d.nombres || "").toUpperCase();
    texto(doc, nombre, CX, 70 + Y, { tam: nombre.length > 34 ? 21 : 25, estilo: "bold" });
    doc.setDrawColor(SENAL[0], SENAL[1], SENAL[2]);
    doc.setLineWidth(0.6);
    doc.line(CX - L.linea, 74 + Y, CX + L.linea, 74 + Y);

    let linea = "con cédula o pasaporte N.º " + d.cedula;
    if (d.empresa) linea += ", de la empresa " + d.empresa + ",";
    texto(doc, linea, CX, 82 + Y, { tam: 11.5, color: GRIS });
    texto(doc, esAsistencia ? "asistió a la capacitación" : "aprobó el curso", CX, 88.5 + Y, { tam: 11.5, color: GRIS });

    // --- Curso (puede ocupar dos líneas) ---
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    const lineasCurso = doc.splitTextToSize(String(d.curso || ""), L.curso).slice(0, 2);
    doc.setTextColor(PINO[0], PINO[1], PINO[2]);
    doc.text(lineasCurso, CX, 98 + Y, { align: "center" });
    let y = 98 + Y + (lineasCurso.length - 1) * 7.5;

    // --- Descripción ampliada: modalidad, fecha, duración y resultado ---
    y = parrafo(doc, descripcion(d, esAsistencia), CX, y + 8.5, L.desc, 10.5, 5);

    // --- Contenidos desarrollados (subtemas) ---
    const subtemas = (Array.isArray(d.subtemas) ? d.subtemas : []).map(function (t) { return String(t).trim(); }).filter(Boolean);
    if (subtemas.length) contenidos(doc, subtemas, CX, y + 3, L.limite + Y, L.col, L.curso - 10);

    // --- Firma (izquierda) ---
    doc.setDrawColor(TINTA[0], TINTA[1], TINTA[2]);
    doc.setLineWidth(0.3);
    doc.line(L.firma - 35, 174 + Y, L.firma + 35, 174 + Y);
    texto(doc, "Responsable de capacitación", L.firma, 179 + Y, { tam: 10, estilo: "bold" });
    texto(doc, "VitalWork S.A.S.", L.firma, 184 + Y, { tam: 10, color: GRIS });

    // --- Fecha (centro) ---
    texto(doc, "Fecha de emisión", L.fecha, 174 + Y, { tam: 10, color: GRIS });
    texto(doc, fechaLarga(d.emitido_en || d.fecha), L.fecha, 180 + Y, { tam: 12, estilo: "bold" });

    // --- QR y código (derecha) ---
    const url = urlVerificacion(d.codigo);
    dibujarQR(doc, url, L.qr, 154 + Y, 28);
    texto(doc, "Código: " + d.codigo, L.qr - 6, 170 + Y, { tam: 10, estilo: "bold", color: PINO_CLARO, alinear: "right" });
    texto(doc, "Escanea el código QR o verifica", L.qr - 6, 176 + Y, { tam: 8.5, color: GRIS, alinear: "right" });
    texto(doc, "en la página de Nexus Learning", L.qr - 6, 180.5 + Y, { tam: 8.5, color: GRIS, alinear: "right" });

    doc.save("Certificado_" + d.codigo + ".pdf");
  }

  return { generar: generar };
})();
