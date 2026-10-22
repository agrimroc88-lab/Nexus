// =====================================================================
// NEXUS ACADEMY (NEXUS ACADEMY) · CERTIFICADO EN PDF
// Carpeta: js/certificado.js
// Dibuja el certificado (A4 horizontal) con código QR de verificación.
// Para cambiar el diseño del certificado, solo se edita este archivo.
// jsPDF y qrcode-generator se cargan solos cuando hacen falta.
// =====================================================================

const NexusCertificado = (function () {
  const PINO = [18, 58, 122];
  const PINO_CLARO = [31, 85, 168];
  const SENAL = [227, 179, 65];
  const TINTA = [20, 32, 58];
  const GRIS = [85, 98, 122];

  // ---------------- Capacitación EN ALIANZA CON VITALWORK ----------------
  // Se marca en Empresas → la capacitación. Imágenes en la carpeta img:
  //   img/logo-vitalwork.png  (logo, de preferencia con fondo transparente)
  //   img/firma-vitalwork.png (firma de la representante, fondo transparente)
  const ALIANZA = {
    nombre: "VitalWork S.A.S.",
    firmante: "Lcda. Elenymar Morales M.",
    cargo: "Representante Legal · VitalWork"
  };

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
    return frase + ", cumpliendo los objetivos de aprendizaje del programa.";
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

  // Imágenes del certificado, precargadas: logo y firma del director
  function precargar(src, listo) {
    const im = new Image();
    im.onload = function () {
      try {
        const c = document.createElement("canvas");
        c.width = im.naturalWidth; c.height = im.naturalHeight;
        c.getContext("2d").drawImage(im, 0, 0);
        listo({ datos: c.toDataURL("image/png"), prop: im.naturalWidth / im.naturalHeight });
      } catch (e) { /* sin imagen: se usa el respaldo */ }
    };
    im.src = src;
  }
  let logo = null, firma = null;
  precargar("img/logo-certificado.png", function (i) { logo = i; });
  precargar("img/firma-director.png", function (i) { firma = i; });
  let logoAliado = null, firmaAliado = null;
  precargar("img/logo-vitalwork.png", function (i) { logoAliado = i; });
  precargar("img/firma-vitalwork.png", function (i) { firmaAliado = i; });

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

  // --- Fondo: triángulos azules y dorados en las esquinas; logo y nombre centrados ---
  function fondo(doc, W, H, alianza) {
    doc.setFillColor(SENAL[0], SENAL[1], SENAL[2]);
    doc.triangle(W - 84, 0, W, 0, W, 54, "F");
    doc.triangle(0, H - 54, 0, H, 84, H, "F");
    doc.setFillColor(PINO[0], PINO[1], PINO[2]);
    doc.triangle(W - 76, 0, W, 0, W, 49, "F");
    doc.triangle(0, H - 49, 0, H, 76, H, "F");
    doc.setFillColor(PINO_CLARO[0], PINO_CLARO[1], PINO_CLARO[2]);
    doc.triangle(W - 40, 0, W, 0, W, 26, "F");
    doc.triangle(0, H - 26, 0, H, 40, H, "F");
    const base = { cx: W / 2, dy: 2, curso: 220, desc: 225, linea: 85, firma: 78, fecha: W / 2 + 4, qr: 238, limite: 147, col: 84 };
    const h = 28, w = logo ? h * logo.prop : 28, tw = 66;
    // Con alianza: logo de VitalWork a la derecha, separado por una línea
    let ah = 0, aw = 0;
    if (alianza) {
      ah = 25; aw = logoAliado ? ah * logoAliado.prop : 40;
      if (aw > 68) { aw = 68; ah = logoAliado ? aw / logoAliado.prop : ah; }
    }
    const total = w + 4 + tw + (alianza ? 14 + aw : 0);
    const x0 = W / 2 - total / 2 - (alianza ? 8 : 0);
    marca(doc, x0, 9, h);
    if (alianza) {
      const xs = x0 + w + 4 + tw + 6;
      doc.setDrawColor(SENAL[0], SENAL[1], SENAL[2]);
      doc.setLineWidth(0.5);
      doc.line(xs, 10, xs, 36);
      const xa = xs + 8;
      texto(doc, "EN ALIANZA CON", xa + aw / 2, 12, { tam: 6.5, estilo: "bold", color: GRIS });
      if (logoAliado) doc.addImage(logoAliado.datos, "PNG", xa, 14 + (25 - ah) / 2, aw, ah, "logoAliado", "FAST");
      else texto(doc, ALIANZA.nombre, xa + aw / 2, 26, { tam: 11, estilo: "bold", color: PINO });
    }
    texto(doc, "NEXUS ACADEMY", x0 + w + 4, 22, { tam: 17, estilo: "bold", color: PINO, alinear: "left" });
    doc.setFillColor(SENAL[0], SENAL[1], SENAL[2]);
    doc.rect(x0 + w + 4, 25.5, 26, 1.3, "F");
    texto(doc, "Capacitación y Desarrollo Profesional", x0 + w + 4, 32, { tam: 9, color: GRIS, alinear: "left" });
    return Object.assign(base, { dy: 5 });
  }

  // ---------------- Sello dorado de la Dirección Académica ----------------
  // Posición elegida por el director: centro 111 × 168,5 mm · diámetro 35,5 mm · giro −20°
  const SELLO = { x: 111, y: 168.5, escala: 35.5 / 34.4, giro: -20, color: [176, 128, 20] };

  // Texto en el arco de arriba (giro en grados, a favor del reloj)
  function textoArriba(doc, txt, cx, cy, r, tam, color, giro) {
    doc.setFont("helvetica", "bold"); doc.setFontSize(tam);
    doc.setTextColor(color[0], color[1], color[2]);
    let t = (-90 + giro) * Math.PI / 180 - (doc.getTextWidth(txt) / 2) / r;
    for (const ch of txt) {
      const w = doc.getTextWidth(ch), tm = t + (w / 2) / r;
      const x = cx + r * Math.cos(tm) - (w / 2) * Math.cos(tm + Math.PI / 2);
      const y = cy + r * Math.sin(tm) - (w / 2) * Math.sin(tm + Math.PI / 2);
      doc.text(ch, x, y, { angle: -(tm * 180 / Math.PI + 90) });
      t += w / r;
    }
  }
  // Texto en el arco de abajo, legible de izquierda a derecha
  function textoAbajo(doc, txt, cx, cy, r, tam, color, giro) {
    doc.setFont("helvetica", "bold"); doc.setFontSize(tam);
    doc.setTextColor(color[0], color[1], color[2]);
    let t = (90 + giro) * Math.PI / 180 + (doc.getTextWidth(txt) / 2) / r;
    for (const ch of txt) {
      const w = doc.getTextWidth(ch), tm = t - (w / 2) / r;
      const x = cx + r * Math.cos(tm) - (w / 2) * Math.cos(tm - Math.PI / 2);
      const y = cy + r * Math.sin(tm) - (w / 2) * Math.sin(tm - Math.PI / 2);
      doc.text(ch, x, y, { angle: -(tm * 180 / Math.PI - 90) });
      t -= w / r;
    }
  }

  function sello(doc) {
    const c = SELLO.color, k = SELLO.escala, cx = SELLO.x, cy = SELLO.y, g = SELLO.giro;
    doc.saveGraphicsState();
    doc.setGState(new doc.GState({ opacity: 0.85 }));
    doc.setDrawColor(c[0], c[1], c[2]);
    // Borde dentado
    doc.setLineWidth(0.6);
    const n = 40, pts = [];
    for (let i = 0; i <= n * 2; i++) {
      const a = i * Math.PI / n + g * Math.PI / 180, r = (i % 2 ? 15.6 : 16.6) * k;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    doc.lines(pts.slice(1).map(function (p, i) { return [p[0] - pts[i][0], p[1] - pts[i][1]]; }), pts[0][0], pts[0][1], [1, 1], "S", true);
    doc.setLineWidth(0.35);
    doc.circle(cx, cy, 14.4 * k, "S");
    doc.circle(cx, cy, 8.8 * k, "S");
    textoArriba(doc, "NEXUS ACADEMY", cx, cy, 10.8 * k, 6.4 * k, c, g);
    textoAbajo(doc, "DIRECCIÓN ACADÉMICA", cx, cy, 12.6 * k, 4.8 * k, c, g);
    // "VW" al centro, girado con el sello
    doc.setFont("helvetica", "bold"); doc.setFontSize(11 * k); doc.setTextColor(c[0], c[1], c[2]);
    const w = doc.getTextWidth("VW"), a = g * Math.PI / 180, dx = -w / 2, dy = 1.6 * k;
    doc.text("VW", cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a), { angle: -g });
    doc.restoreGraphicsState();
  }

  function dibujar(d) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const W = 297, H = 210;

    // --- Fondo y marca ---
    const alianza = d.alianza === true;
    const L = fondo(doc, W, H, alianza);
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
    texto(doc, (esAsistencia ? "asistió a la capacitación" : "aprobó el curso") + (alianza ? (esAsistencia ? " dictada" : " dictado") + " en alianza con " + ALIANZA.nombre : ""), CX, 88.5 + Y, { tam: 11.5, color: GRIS });

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

    // --- Firma del director (izquierda) ---
    if (firma) {
      // Posición elegida por el director: centro 80,7 mm · base 203,6 mm · alto 50 mm · giro 2°
      const fh = 51.4, fw = fh * firma.prop;
      doc.addImage(firma.datos, "PNG", 80.7 - fw / 2, 152.9, fw, fh, "firma", "FAST");
    }
    doc.setDrawColor(TINTA[0], TINTA[1], TINTA[2]);
    doc.setLineWidth(0.3);
    doc.line(L.firma - 35, 174 + Y, L.firma + 35, 174 + Y);
    texto(doc, "Dr. Leonardo Arias E.", L.firma, 180 + Y, { tam: 10, estilo: "bold" });
    texto(doc, "Director de Nexus Academy", L.firma, 185 + Y, { tam: 9.5, color: GRIS });

    if (alianza) {
      // --- Segunda firma: representante de VitalWork (centro) ---
      const fx = 150;
      if (firmaAliado) {
        let fh = 30, fw = fh * firmaAliado.prop;
        if (fw > 50) { fw = 50; fh = fw / firmaAliado.prop; }
        doc.addImage(firmaAliado.datos, "PNG", fx - fw / 2, 176 + Y - fh, fw, fh, "firmaAliado", "FAST");
      }
      doc.setDrawColor(TINTA[0], TINTA[1], TINTA[2]);
      doc.setLineWidth(0.3);
      doc.line(fx - 24, 174 + Y, fx + 24, 174 + Y);
      texto(doc, ALIANZA.firmante, fx, 180 + Y, { tam: 10, estilo: "bold" });
      texto(doc, ALIANZA.cargo, fx, 185 + Y, { tam: 9.5, color: GRIS });
      // La fecha pasa debajo del código QR
      texto(doc, "Emitido el " + fechaLarga(d.emitido_en || d.fecha), L.qr - 6, 186 + Y, { tam: 8.5, estilo: "bold", color: TINTA, alinear: "right" });
    } else {
      // --- Fecha (centro) ---
      texto(doc, "Fecha de emisión", L.fecha, 174 + Y, { tam: 10, color: GRIS });
      texto(doc, fechaLarga(d.emitido_en || d.fecha), L.fecha, 180 + Y, { tam: 12, estilo: "bold" });
    }

    // --- QR y código (derecha) ---
    const url = urlVerificacion(d.codigo);
    dibujarQR(doc, url, L.qr, 154 + Y, 28);
    texto(doc, "Código: " + d.codigo, L.qr - 6, 170 + Y, { tam: 10, estilo: "bold", color: PINO_CLARO, alinear: "right" });
    texto(doc, "Escanea el código QR o verifica", L.qr - 6, 176 + Y, { tam: 8.5, color: GRIS, alinear: "right" });
    texto(doc, "en la página de Nexus Academy", L.qr - 6, 180.5 + Y, { tam: 8.5, color: GRIS, alinear: "right" });

    // --- Sello dorado ---
    sello(doc);

    // --- Certificado de ejemplo: marca de agua y se abre para mostrar (no se descarga) ---
    if (d.muestra) {
      doc.saveGraphicsState();
      doc.setGState(new doc.GState({ opacity: 0.13 }));
      doc.setFont("helvetica", "bold");
      doc.setFontSize(110);
      doc.setTextColor(PINO[0], PINO[1], PINO[2]);
      doc.text("MUESTRA", W / 2, H / 2 + 22, { align: "center", angle: 18 });
      doc.restoreGraphicsState();
      return doc;
    }

    doc.save("Certificado_" + d.codigo + ".pdf");
  }

  // jsPDF y el lector de QR se descargan solo al pedir el certificado
  function cargar(url) {
    return new Promise(function (ok, falla) {
      const s = document.createElement("script");
      s.src = url;
      s.onload = ok;
      s.onerror = function () { s.remove(); falla(new Error(url)); };
      document.head.appendChild(s);
    });
  }
  function librerias() {
    const pendientes = [];
    if (!window.jspdf) pendientes.push(cargar("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"));
    if (typeof qrcode === "undefined") pendientes.push(cargar("https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"));
    return Promise.all(pendientes);
  }
  // Ejemplo para mostrar: abre una pestaña al instante (evita el bloqueo de ventanas)
  // y la llena cuando el PDF está listo.
  function muestra(d) {
    const ventana = window.open("", "_blank");
    if (ventana) ventana.document.write("<p style='font:16px sans-serif;padding:24px'>Preparando el certificado de ejemplo…</p>");
    return librerias().then(function () {
      const doc = dibujar(Object.assign({ codigo: "VW-" + new Date().getFullYear() + "-MUESTRA0", cedula: "0000000000", nombres: "Nombre del participante" }, d, { muestra: true }));
      const url = doc.output("bloburl");
      if (ventana) ventana.location.href = url;
      else doc.save("Certificado_de_ejemplo.pdf");
    }).catch(function (e) {
      console.error(e);
      if (ventana) ventana.close();
      alert("No se pudo generar el certificado de ejemplo. Revisa tu conexión e inténtalo de nuevo.");
    });
  }
  // ¿El certificado es de una capacitación en alianza? (si no se sabe, se consulta)
  function revisarAlianza(d) {
    if (typeof d.alianza === "boolean" || !d.codigo || typeof nexusDb === "undefined") return Promise.resolve(d);
    return Promise.resolve(nexusDb.rpc("cap_certificado_alianza", { p_codigo: d.codigo }))
      .then(function (r) { return Object.assign({}, d, { alianza: !r.error && r.data === true }); })
      .catch(function () { return d; });
  }
  function generar(d) {
    return Promise.all([librerias(), revisarAlianza(d)]).then(function (r) { dibujar(r[1]); }).catch(function (e) {
      console.error(e);
      alert("No se pudo generar el certificado. Revisa tu conexión e inténtalo de nuevo.");
    });
  }
  // Se adelanta la descarga cuando el navegador está libre
  if ("requestIdleCallback" in window) requestIdleCallback(function () { librerias().catch(function () {}); });
  else setTimeout(function () { librerias().catch(function () {}); }, 3000);

  return { generar: generar, muestra: muestra };
})();
