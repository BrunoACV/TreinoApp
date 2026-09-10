import os
import sys
import json
import time
import re
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE_DIR = r"C:\Trabalho\IA\Projetos\Aplicações android\TreinoApp"
GIFS_DIR = os.path.join(BASE_DIR, "gifs")
CATALOG_FILE = os.path.join(BASE_DIR, "exercises.json")
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

os.makedirs(GIFS_DIR, exist_ok=True)

def sanitize_filename(name):
    clean = re.sub(r'[<>:"/\\|?*]', "_", name)
    return clean.strip()

def infer_equipment(name):
    n = name.lower()
    equipments = []
    if "barra" in n or "barbell" in n:
        equipments.append("Barra")
    if "halter" in n or "dumbbell" in n:
        equipments.append("Halteres")
    if "cabo" in n or "polia" in n or "pulley" in n or "cross" in n:
        equipments.append("Cabo / Polia")
    if "máquina" in n or "maquina" in n or "alavanca" in n or "leg press" in n or "pec deck" in n:
        equipments.append("Máquina")
    if "kettlebell" in n:
        equipments.append("Kettlebell")
    if "faixa" in n or "elástico" in n or "elastico" in n or "banda" in n or "band" in n:
        equipments.append("Elástico / Faixa")
    if "smith" in n:
        equipments.append("Smith")
    if "trx" in n or "argola" in n:
        equipments.append("TRX / Argolas")
    if "banco" in n:
        equipments.append("Banco")
    if "bola" in n or "bosu" in n or "suíça" in n or "suica" in n:
        equipments.append("Bola / Bosu")
    if "rolo" in n:
        equipments.append("Rolo de Espuma")
    if "gymstick" in n:
        equipments.append("Gymstick")
    if "landmine" in n:
        equipments.append("Landmine")
    if not equipments or "peso corporal" in n or "corpo" in n or "calistenia" in n or "livre" in n or "chão" in n or "chao" in n:
        if not equipments:
            equipments.append("Peso Corporal")
    return equipments

def fetch_catalog():
    print("Obtendo catalogo de exercicios do site...")
    all_items = []
    page = 1
    while True:
        url = f"https://www.gifdotreino.com/search_gifs.php?q=&page={page}"
        req = urllib.request.Request(url, headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if not data:
                break
            all_items.extend(data)
            page += 1
        except Exception as e:
            print(f"  Erro ao ler pagina {page}: {e}")
            break
    print(f"Catalogo completo com {len(all_items)} exercicios!")
    return all_items

def download_single_gif(item, index, total):
    raw_path = (item.get("path") or item.get("original_path", "")).replace("\\", "/")
    filename = item.get("gif_file") or (sanitize_filename(item["name"]) + ".gif")
    dest_path = os.path.join(GIFS_DIR, filename)

    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 1000:
        return item["name"], True, os.path.getsize(dest_path), filename, "cache"

    encoded_parts = [urllib.parse.quote(part) for part in raw_path.split("/")]
    url = "https://www.gifdotreino.com/" + "/".join(encoded_parts)

    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
            if len(data) > 1000:
                with open(dest_path, "wb") as f:
                    f.write(data)
                return item["name"], True, len(data), filename, "downloaded"
            else:
                time.sleep(1)
        except Exception as e:
            if attempt == 2:
                return item["name"], False, 0, filename, str(e)
            time.sleep(1.5)
    return item["name"], False, 0, filename, "falha desconhecida"

def main():
    items = fetch_catalog()
    if not items:
        print("Erro: nenhum item retornado.")
        sys.exit(1)

    structured = []
    seen_names = set()

    for idx, item in enumerate(items):
        name = item["name"].strip()
        if name in seen_names:
            continue
        seen_names.add(name)

        parts = item["path"].replace("\\", "/").split("/")
        category = parts[1] if len(parts) >= 3 else "Geral"
        filename = sanitize_filename(name) + ".gif"
        equipments = infer_equipment(name)

        desc = item.get("description", "")
        if not desc or desc.startswith("Descrição para o exercício:"):
            desc = f"Exercício focado em {category.lower()} com execução controlada e postura alinhada."

        structured.append({
            "id": f"ex_{idx+1}",
            "name": name,
            "category": category,
            "equipments": equipments,
            "gif_file": filename,
            "original_path": item["path"],
            "description": desc,
            "favorite": False
        })

    print(f"\nIniciando download paralelo de {len(structured)} GIFs com 14 threads...")
    start_time = time.time()
    total = len(structured)
    completed = 0
    total_bytes = 0
    failures = []

    with ThreadPoolExecutor(max_workers=14) as executor:
        future_to_item = {executor.submit(download_single_gif, ex, i, total): ex for i, ex in enumerate(structured)}
        for future in as_completed(future_to_item):
            completed += 1
            name, success, size, filename, status = future.result()
            if success:
                total_bytes += size
            else:
                failures.append((name, status))
            
            if completed % 25 == 0 or completed == total:
                elapsed = time.time() - start_time
                mb = total_bytes / (1024 * 1024)
                rate = mb / elapsed if elapsed > 0 else 0
                print(f"[{completed}/{total}] {completed*100/total:.1f}% | {mb:.1f} MB baixados ({rate:.2f} MB/s)")

    print(f"\nFinalizado em {time.time() - start_time:.1f}s!")
    print(f"Total baixado: {total_bytes / (1024*1024):.2f} MB")
    if failures:
        print(f"Avisos: {len(failures)} arquivos falharam: {failures[:5]}")

    with open(CATALOG_FILE, "w", encoding="utf-8") as f:
        json.dump(structured, f, ensure_ascii=False, indent=2)
    print(f"Catalogo salvo em: {CATALOG_FILE}")

    # Copy script to project directory
    script_dest = os.path.join(BASE_DIR, "scripts", "extrair_todos_gifs.py")
    with open(__file__, "r", encoding="utf-8") as f_in, open(script_dest, "w", encoding="utf-8") as f_out:
        f_out.write(f_in.read())
    print(f"Script copiado para: {script_dest}")

if __name__ == "__main__":
    main()
