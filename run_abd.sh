#!/bin/bash
set -x
#date_ini="$(date +'%Y%m%d')"
#date_ini="20260519"
date_ini=$1


  scp root@172.21.0.13:/root/Script/PSX/PROCESADOS/MTYSAJPSX01_*_$date_ini.csv /home/airflow/portabilidad
  sleep 1
  scp /home/airflow/portabilidad/MTYSAJPSX01_*_$date_ini.csv root@10.131.8.5:/opt/sonus/ems/weblogic/sonusEms/data/cli/scripts/
  sleep 1
  python3 /home/airflow/Scripts/portabilildad/mtysajpsx01_expect.py --type PORTED --date $date_ini
  sleep 5
  python3 /home/airflow/Scripts/portabilildad/mtysajpsx01_expect.py --type DELETED --date $date_ini
