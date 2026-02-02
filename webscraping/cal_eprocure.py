
import lxml.html

import logging
import time
import csv

import lxml.html # similar to beautifulsoup
import requests # for making HTTP requests

logging.basicConfig(level=logging.INFO)

# constants 
BASE_URL = 'https://caleprocure.ca.gov'
SEARCH_URL = 'https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx'
MAX_WAIT = 128 
OUT_FILE = 'proposals.csv'

START_PAGE = 1
END_PAGE = 4 #sys.maxsize

headers = {
    'user-agent': 'Mozilla'
}


class Entry:
    def __init__(self, elem):
        self.elem = elem

    # a getter, but this is run like a method
    @property
    def title(self):
        return self.elem.cssselect('h4 a.no-decoration')[0].text_content().strip()
    
    @property
    def num_likes(self):
        likes_text = self.elem.cssselect(
            'span[data-modal-trigger="signup"]'
        )[0].text_content().strip()
        number = int(likes_text.split(' ', 1)[0]) # 1 means split at most once
        return number # '123 likes' -> 123
    
    @property
    def url(self):
        relative_url = self.elem.cssselect('h4 a.no-decoration')[0].get('href')
        full_url = URL_PREFIX + relative_url
        return full_url
    
    def as_dict(self):
        return {
            'title': self.title,
            'num_likes': self.num_likes,
            'url': self.url
        }
    
class Page:
    def __init__(self, elem): # elem is an lxml element
        self.elem = elem

    @classmethod
    def from_text(cls, text):
        elem = lxml.html.fromstring(text)
        return cls(elem) # cls is a Class object 
    
    def __iter__(self):
        print(self.elem)
        story_entries = self.elem.cssselect('div.submission')
        for elem in story_entries:
            yield Entry(elem)

def main(start, end):
    with open(OUT_FILE, mode='w') as csv_file:
        csv_out = csv.DictWriter(csv_file, fieldnames=['title', 'num_likes', 'url'])
        csv_out.writeheader()

        wait = 1 # for implementing exponential backoff
        for pagenum in range(start, end + 1):
            url = URL_TEMPLATE.format(pagenum=pagenum)
            logging.info(f'Fetching page {pagenum} from {url}')

            page_end = False
            
            while True:
                response = requests.get(url, headers=headers)
                if response.status_code == 429:
                    logging.info(f'got status code {response.status_code}, waiting for {wait} seconds before retrying...')
                    time.sleep(wait)
                    wait = min(wait * 2, MAX_WAIT)
                    continue
                if response.status_code == 404:
                    logging.info(f'got status code {response.status_code}, assuming no more pages left.')
                    page_end = True
                    break
                assert response.status_code == 200, response.status_code
                break
            if page_end:
                logging.info('End signal found, stopping crawl.')
                break

            #print(response.text)
            for entry in iter(Page.from_text(response.text)):
                csv_out.writerow(entry.as_dict())