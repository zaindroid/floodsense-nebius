FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY floodsense_agents ./floodsense_agents

EXPOSE 8100
CMD ["python", "-m", "floodsense_agents"]
