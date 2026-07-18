# 📚 Reglas de Negocio — Portabilidad

> Archivo append-only. No sobrescribir entradas existentes.

---

## Módulo: General

### Regla: Proceso de Portabilidad
**Descripción:** Sistema de sincronización y portabilidad de datos entre bases de datos (MSSQL/Oracle) y equipos SONUS/PSX.

### Ejemplo
Ejecución programada del script `mtysajpsx01.py` para sincronizar configuraciones contra el equipo PSX, y `full_sync.py` para comparar y generar diferencias entre bases de datos.

### Impacto
Sistemas afectados: Base de datos ABD (MSSQL), Base de datos PSX (Oracle), Equipo SONUS/EMS.

---
