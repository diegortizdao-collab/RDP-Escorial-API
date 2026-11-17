-- Datos iniciales. Idempotente.
INSERT INTO rdp_areas (nombre) VALUES
 ('Administración'),('Almacén'),('Calidad Central'),('Comercial'),('Comex'),('Compras'),('Ingeniería e Innovación'),
 ('Ingeniería de Producto'),('Inyección y Mecanizado'),('Logística'),('Mantenimiento Central'),('Mantenimiento Edilicio'),
 ('Marketing'),('Mejora Continua'),('Planificación'),('Post Venta'),('Producto'),('Producto Comercial'),('Proyectos'),
 ('Recursos Humanos'),('Seguridad Patrimonial'),('Seguridad, Higiene y Medio Ambiente'),('Sistemas'),('Supply Chain'),
 ('UET 1'),('UET 2'),('UET 3'),('UET 4'),('UET 5')
ON CONFLICT DO NOTHING;

INSERT INTO rdp_estructura (planta, uet, sector) VALUES
 ('Suipacha','UET 4','Armado Gas'),('Suipacha','UET 4','Armado Eléctrico'),('Suipacha','UET 4','Calefones'),('Suipacha','UET 4','Soldadura'),
 ('Suipacha','UET 5','Pintura'),('Suipacha','UET 5','Prensa'),('Suipacha','Matricería','Matricería'),('Suipacha','Mantenimiento','Mantenimiento'),
 ('25 de Mayo','UET 1','Cocinas'),('25 de Mayo','UET 1','Prearmado'),
 ('25 de Mayo','UET 2','Welding'),('25 de Mayo','UET 2','Enlozado'),('25 de Mayo','UET 2','Gema'),
 ('25 de Mayo','UET 3','Corte'),('25 de Mayo','UET 3','Estampado'),
 ('25 de Mayo','Matricería','Matricería'),('25 de Mayo','Mantenimiento','Mantenimiento')
ON CONFLICT DO NOTHING;

-- Primer administrador
INSERT INTO rdp_usuarios (email, nombre, apellido, area, rol, activo, ts)
VALUES ('dortiz@escorial.com.ar','Diego','Ortiz','Mejora Continua','Administrador',TRUE,(extract(epoch from now())*1000)::bigint)
ON CONFLICT (email) DO NOTHING;

-- Matriz de costos: valores migrados de la pantalla "Valores" de Kaizenio. AJUSTAR con la matriz oficial de Escorial.
INSERT INTO rdp_matriz (concepto, unidad, fuente) VALUES
 ('Aluminio','Kg','Kaizenio (migrado)'),('Chapa','Kg','Kaizenio (migrado)'),
 ('Mano de Obra Directa','Hs','Kaizenio (migrado)'),('Mano de Obra Indirecta','Hs','Kaizenio (migrado)'),
 ('Recambio de Producto','U','Kaizenio (migrado)'),('Servicio Técnico','U','Kaizenio (migrado)')
ON CONFLICT (concepto) DO NOTHING;
INSERT INTO rdp_matriz_ver (matriz_id, desde, costo, por, ts)
SELECT m.id, DATE '2026-11-01', v.costo, 'seed', (extract(epoch from now())*1000)::bigint
FROM rdp_matriz m JOIN (VALUES ('Aluminio',5553),('Chapa',1384),('Mano de Obra Directa',7650),
  ('Mano de Obra Indirecta',15778),('Recambio de Producto',350000),('Servicio Técnico',60000)) AS v(concepto,costo)
  ON v.concepto = m.concepto
ON CONFLICT (matriz_id, desde) DO NOTHING;
