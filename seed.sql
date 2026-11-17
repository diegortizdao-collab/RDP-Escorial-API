-- Datos iniciales. Idempotente.
INSERT INTO rdp_areas (nombre) VALUES
 ('Administración'),('Almacén'),('Calidad Central'),('Comercial'),('Comex'),('Compras'),('Ingeniería e Innovación'),
 ('Ingeniería de Producto'),('Inyección y Mecanizado'),('Logística'),('Mantenimiento Central'),('Mantenimiento Edilicio'),
 ('Marketing'),('Mejora Continua'),('Planificación'),('Post Venta'),('Producto'),('Producto Comercial'),('Proyectos'),
 ('Recursos Humanos'),('Seguridad Patrimonial'),('Seguridad, Higiene y Medio Ambiente'),('Sistemas'),('Supply Chain'),
 ('UET 1'),('UET 2'),('UET 3'),('UET 4'),('UET 5')
ON CONFLICT DO NOTHING;

-- Estructura: Gerencia > Área > Sector (organigrama de Escorial). Planta va aparte en cada RDP.
INSERT INTO rdp_estructura (gerencia, area, sector) VALUES
 ('Industrial','UET 1','Cocinas'),
 ('Industrial','UET 1','Prearmado'),
 ('Industrial','UET 2','Welding'),
 ('Industrial','UET 2','Enlozado'),
 ('Industrial','UET 2','Gema'),
 ('Industrial','UET 3','Corte'),
 ('Industrial','UET 3','Estampado'),
 ('Industrial','UET 4','Armado Gas'),
 ('Industrial','UET 4','Armado Eléctrico'),
 ('Industrial','UET 4','Calefones'),
 ('Industrial','UET 4','Soldadura'),
 ('Industrial','UET 5','Pintura'),
 ('Industrial','UET 5','Prensa'),
 ('Industrial','Mantenimiento 25 de Mayo',''),
 ('Industrial','Mantenimiento Suipacha',''),
 ('Industrial','Moldes y Matrices',''),
 ('Industrial','Mejora Continua',''),
 ('Calidad, Seguridad, Higiene y Medio Ambiente','Seguridad, Higiene y Medio Ambiente',''),
 ('Calidad, Seguridad, Higiene y Medio Ambiente','Aseguramiento de Calidad',''),
 ('Supply Chain','Programación y Control de Producción',''),
 ('Supply Chain','Logística','Expedición'),
 ('Supply Chain','Almacén',''),
 ('Supply Chain','Compras',''),
 ('RRHH, Administración y Sistemas','Sistemas',''),
 ('RRHH, Administración y Sistemas','Recursos Humanos',''),
 ('RRHH, Administración y Sistemas','Contaduría',''),
 ('RRHH, Administración y Sistemas','Tesorería',''),
 ('RRHH, Administración y Sistemas','Cuentas Corrientes y Cobranzas',''),
 ('RRHH, Administración y Sistemas','Créditos',''),
 ('RRHH, Administración y Sistemas','Seguridad Patrimonial',''),
 ('Ventas','Ventas',''),
 ('Ventas','Marketing',''),
 ('Ventas','Producto',''),
 ('Ventas','Key Account',''),
 ('Post Venta','Servicio Post Venta',''),
 ('Post Venta','Ingeniería de Producto',''),
 ('Post Venta','Call Center',''),
 ('Proyectos','Proyectos',''),
 ('Mecanizado e Inyección','Mecanizado e Inyección',''),
 ('Mantenimiento Edilicio 25 de Mayo','Mantenimiento Edilicio 25 de Mayo',''),
 ('Ingeniería e Innovación','Ingeniería e Innovación','')
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
