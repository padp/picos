import os

from flask import Flask, jsonify
from flask_cors import CORS
from pymongo import MongoClient
from pymongo.server_api import ServerApi

app = Flask(__name__)
CORS(app)

sql_pass = os.environ["SQL_PASS"]
client = MongoClient(
    f"mongodb+srv://padpress1:{sql_pass}@cluster0.ywwxl.mongodb.net/"
    "?retryWrites=true&w=majority&appName=Cluster0"
)
collection = client["press_db"]["press_data"]


@app.get("/")
def health():
    return jsonify({"status": "ok"})


@app.get("/data")
def get_data():
    doc = collection.find_one({})
    if doc is None:
        return jsonify([])
    doc["_id"] = str(doc["_id"])
    return jsonify([doc])


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
