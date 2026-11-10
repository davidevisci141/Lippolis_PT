import { PaddleOCR } from "@paddleocr/paddleocr-js";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import heic2any from "heic2any";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export { PaddleOCR, pdfjs, heic2any };
