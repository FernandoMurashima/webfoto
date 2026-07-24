# Deploy do backend de fotos

O Angular chama a API em `/api`. Em producao, o dominio precisa encaminhar `/api` para o container da API e o restante para o container `webfoto`.

## 1. Criar banco no MySQL do Docker

Entre no Ubuntu e rode:

```bash
docker exec -it mysql mysql -uroot -p
```

Dentro do MySQL:

```sql
CREATE DATABASE IF NOT EXISTS webfoto CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

## 2. Subir a API

Na pasta do projeto no servidor, construa a imagem:

```bash
docker build -f server/Dockerfile -t webfoto-api .
```

Depois rode o container na mesma rede do MySQL:

```bash
docker run -d \
  --name webfoto-api \
  --restart unless-stopped \
  --network stacks_default \
  -e MYSQL_HOST=mysql \
  -e MYSQL_USER=root \
  -e MYSQL_PASSWORD='SENHA_DO_MYSQL' \
  -e MYSQL_DATABASE=webfoto \
  -e TOKEN_SECRET='TROQUE_POR_UM_SEGREDO_GRANDE' \
  -e ADMIN_LOGIN=admin \
  -e ADMIN_PASSWORD='mayara2026' \
  -e MAX_PHOTO_SIZE=62914560 \
  -v webfoto_uploads:/app/uploads \
  -v webfoto_zips:/app/zips \
  webfoto-api
```

Se a rede Docker tiver outro nome, descubra com:

```bash
docker network ls
```

## 3. Configurar o Nginx Proxy Manager

No host do site `www.maymurashima.com.br`, adicione uma localizacao personalizada:

```text
/api
```

Encaminhando para:

```text
http://webfoto-api:3000
```

Mantenha o restante do site apontando para o container `webfoto`.

Em `Advanced`, se o Nginx Proxy Manager rejeitar fotos grandes, adicione:

```nginx
client_max_body_size 70M;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
```

O upload do navegador envia uma foto por requisicao e limita a fila a 4 envios simultaneos.

## 4. Testar

```bash
docker logs webfoto-api
curl http://127.0.0.1/api/health
```

Pelo dominio:

```text
https://www.maymurashima.com.br/api/health
```
