from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import csv
import json
import time
import os
import requests
import boto3
from datetime import datetime

SEARCH_URL = 'https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx'
OUTPUT_CSV = 'all_events_detailed.csv'
OUTPUT_JSON = 'all_events_detailed.json'
BASE_DOWNLOAD_DIR = os.path.abspath('downloads')
MAX_EVENTS = 1000  # ← change to scrape more

from dotenv import load_dotenv
import os

# Point to your Django app's .env directly
load_dotenv(dotenv_path='../back_end/.env')  # adjust path as needed

load_dotenv()  # loads the .env in the same folder

S3_BUCKET = os.environ.get('AWS_STORAGE_BUCKET_NAME')
s3 = boto3.client(
    's3',
    aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
    region_name=os.environ.get('AWS_REGION', 'us-east-1')
)

def upload_event_to_s3(event_data):
    """Upload single event JSON + its attachments immediately after scraping."""
    safe_id = event_data['event_id'].replace('/', '_')

    # Event JSON → scrapes/caleprocure/events/{id}.json
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=f"scrapes/caleprocure/events/{safe_id}.json",
        Body=json.dumps(event_data, indent=2, ensure_ascii=False),
        ContentType='application/json'
    )
    print(f"  ☁ Uploaded event JSON: {safe_id}.json")

    # Attachments → scrapes/caleprocure/attachments/{id}/{filename}
    # (mirrors your uploads/{user_id}/{contract_id}/{filename} pattern)
    event_download_dir = os.path.join(BASE_DOWNLOAD_DIR, safe_id)
    if os.path.exists(event_download_dir):
        for filename in os.listdir(event_download_dir):
            local_path = os.path.join(event_download_dir, filename)
            s3_key = f"scrapes/caleprocure/attachments/{safe_id}/{filename}"
            with open(local_path, 'rb') as f:
                s3.put_object(
                    Bucket=S3_BUCKET,
                    Key=s3_key,
                    Body=f.read(),
                    ContentType='application/pdf'
                )
            print(f"  ☁ Uploaded attachment: {filename}")


def upload_to_s3(all_events):
    """Upload the final combined JSON at the end."""
    s3.put_object(
        Bucket=S3_BUCKET,
        Key='scrapes/caleprocure/all_events.json',
        Body=json.dumps({
            'scrape_date': datetime.now().isoformat(),
            'total_events': len(all_events),
            'events': all_events
        }, indent=2, ensure_ascii=False),
        ContentType='application/json'
    )
    print(f"☁ Uploaded combined JSON: scrapes/caleprocure/all_events.json")


def scrape_event_page(driver, wait):
    def url_is_ready(driver):
        return 'page_loading' not in driver.current_url and '/event/' in driver.current_url

    try:
        wait.until(url_is_ready)
    except:
        print(f"  ✗ URL never resolved: {driver.current_url}")

    event_data = {
        'event_url': driver.current_url,
        'event_id': '',
        'title': '',
        'description': '',
        'contact_name': '',
        'contact_email': '',
        'contact_phone': '',
        'department': '',
        'start_date': '',
        'end_date': '',
        'format': ''
    }

    parts = driver.current_url.split('/')
    if len(parts) >= 4:
        event_data['event_id'] = f"{parts[-2]}/{parts[-1]}"

    try:
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, '[data-if-label="eventName"]')))
    except:
        pass

    try:
        title_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventName"]')
        title = title_elem.text.strip()
        if title and title != '[Event Title]':
            event_data['title'] = title
    except:
        pass

    try:
        desc_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="descriptiondetails"]')
        desc = desc_elem.text.strip()
        if desc and desc != '[Detail Description]':
            event_data['description'] = desc
    except:
        pass

    try:
        contact_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="contactName"]')
        contact = contact_elem.text.strip()
        if contact and contact != '[Contact Name]':
            event_data['contact_name'] = contact
    except:
        pass

    try:
        email_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="emailAnchor"]')
        email = email_elem.text.strip()
        if email and email != '[EmailAddress]':
            event_data['contact_email'] = email
    except:
        try:
            email_elem = driver.find_element(By.ID, 'RESP_INQ_DL0_WK_EMAILID')
            email = email_elem.text.strip()
            if email:
                event_data['contact_email'] = email
        except:
            pass

    try:
        phone_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="phoneText"]')
        phone = phone_elem.text.strip()
        if phone and phone != '[Phone Number]':
            event_data['contact_phone'] = phone
    except:
        pass

    try:
        dept_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="dept"]')
        dept = dept_elem.text.strip()
        if dept:
            event_data['department'] = dept
    except:
        pass

    try:
        start_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventStartDate"]')
        if start_elem.text.strip():
            event_data['start_date'] = start_elem.text.strip()
    except:
        pass

    try:
        end_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventEndDate"]')
        if end_elem.text.strip():
            event_data['end_date'] = end_elem.text.strip()
    except:
        pass

    try:
        format1 = driver.find_element(By.CSS_SELECTOR, '[data-if-label="format1"]').text.strip()
        format2 = driver.find_element(By.CSS_SELECTOR, '[data-if-label="format2"]').text.strip()
        if format1 or format2:
            event_data['format'] = f"{format1} / {format2}".strip(' /')
    except:
        pass

    return event_data


def download_attachments(driver, wait, event_id):
    safe_id = event_id.replace('/', '_')
    event_download_dir = os.path.join(BASE_DOWNLOAD_DIR, safe_id)
    os.makedirs(event_download_dir, exist_ok=True)
    print(f"  [attachments] Saving to: {event_download_dir}")

    try:
        view_pkg_btn = wait.until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, '[data-if-label="viewPackage"]'))
        )
        view_pkg_btn.click()
        print(f"  Clicked 'View Event Package'")
    except Exception as e:
        print(f"  Could not click 'View Event Package': {e}")
        return

    time.sleep(4)
    try:
        wait.until(EC.presence_of_element_located(
            (By.CSS_SELECTOR, '[data-if-label^="ViewAttachmentsTableRow"]')
        ))
    except Exception as e:
        print(f"  Attachments table did not load: {e}")
        return

    download_buttons = driver.find_elements(
        By.CSS_SELECTOR, 'button[data-if-label^="ViewAttachmentsView"]'
    )
    total = len(download_buttons)
    print(f"  Found {total} attachment(s)")

    for i in range(total):
        try:
            download_buttons = driver.find_elements(
                By.CSS_SELECTOR, 'button[data-if-label^="ViewAttachmentsView"]'
            )
            btn = download_buttons[i]
            driver.execute_script("arguments[0].scrollIntoView(true);", btn)
            time.sleep(0.5)
            btn.click()

            wait.until(EC.visibility_of_element_located((By.ID, 'attachmentBox')))
            time.sleep(3)

            download_link = wait.until(EC.element_to_be_clickable((By.ID, 'downloadButton')))
            pdf_url = download_link.get_attribute('href')

            if not pdf_url:
                print(f"  ✗ No URL for attachment #{i + 1}")
            else:
                cookies = {c['name']: c['value'] for c in driver.get_cookies()}
                filename = pdf_url.split('/')[-1].split('?')[0] or f'attachment_{i + 1}.pdf'
                if '.' not in filename:
                    filename += '.pdf'
                filepath = os.path.join(event_download_dir, filename)

                response = requests.get(pdf_url, cookies=cookies, stream=True)
                response.raise_for_status()
                with open(filepath, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)
                print(f"  ✓ Saved locally: {filename}")

            driver.find_element(
                By.CSS_SELECTOR, '#attachmentWrapperModal .btn-outline-primary'
            ).click()
            time.sleep(3)

        except Exception as e:
            print(f"  ✗ Error on attachment #{i + 1}: {e}")
            try:
                driver.find_element(
                    By.CSS_SELECTOR, '#attachmentWrapperModal .btn-outline-primary'
                ).click()
            except:
                pass
            time.sleep(3)


def main():
    os.makedirs(BASE_DOWNLOAD_DIR, exist_ok=True)

    options = webdriver.ChromeOptions()
    options.add_argument('--window-size=1920,1080')

    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    wait = WebDriverWait(driver, 20)

    all_events = []

    try:
        print("\n1. Loading search page...")
        driver.get(SEARCH_URL)
        time.sleep(10)

        print("\n2. Counting events...")
        all_rows = driver.find_elements(By.CSS_SELECTOR, '[data-if-label^="tblBodyTr"]')
        visible_rows = [
            row for row in all_rows
            if 'if-hide' not in (row.get_attribute('class') or '') and row.is_displayed()
        ]
        total_events = min(len(visible_rows), MAX_EVENTS)
        print(f"   Found {len(visible_rows)} events, scraping first {total_events}")

        print("\n3. Scraping events...")
        print("=" * 80)

        for i in range(total_events):
            print(f"\nEvent {i + 1}/{total_events}:")

            try:
                driver.get(SEARCH_URL)
                time.sleep(10)

                all_rows = driver.find_elements(By.CSS_SELECTOR, '[data-if-label^="tblBodyTr"]')
                visible_rows = [
                    row for row in all_rows
                    if 'if-hide' not in (row.get_attribute('class') or '') and row.is_displayed()
                ]

                if i >= len(visible_rows):
                    continue

                row = visible_rows[i]
                original_window = driver.current_window_handle
                original_windows = driver.window_handles

                event_id_cell = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventId"]')
                event_id_cell.click()
                wait.until(lambda d: len(d.window_handles) > len(original_windows))

                new_windows = driver.window_handles
                if len(new_windows) > len(original_windows):
                    new_window = [w for w in new_windows if w not in original_windows][0]
                    driver.switch_to.window(new_window)

                    event_data = scrape_event_page(driver, wait)
                    if event_data['title']:
                        print(f"  Title: {event_data['title'][:60]}")

                    download_attachments(driver, wait, event_data['event_id'])

                    # ← Upload this event immediately after scraping
                    upload_event_to_s3(event_data)

                    all_events.append(event_data)

                    driver.close()
                    driver.switch_to.window(original_window)

            except KeyboardInterrupt:
                print("\n\nInterrupted by user")
                break
            except Exception as e:
                print(f"  Error: {e}")
                try:
                    driver.switch_to.window(original_window)
                except:
                    pass
                continue

        # Save final combined CSV + JSON locally and upload to S3
        print("\n" + "=" * 80)
        print(f"Scraping complete! Collected {len(all_events)} events")

        if all_events:
            with open(OUTPUT_CSV, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=[
                    'event_id', 'event_url', 'title', 'description',
                    'department', 'format', 'start_date', 'end_date',
                    'contact_name', 'contact_email', 'contact_phone'
                ])
                writer.writeheader()
                writer.writerows(all_events)
            print(f"✓ Saved locally: {OUTPUT_CSV}")

            with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
                json.dump({
                    'scrape_date': datetime.now().isoformat(),
                    'total_events': len(all_events),
                    'events': all_events
                }, f, indent=2, ensure_ascii=False)
            print(f"✓ Saved locally: {OUTPUT_JSON}")

            # Upload final combined files to S3
            upload_to_s3(all_events)

        print("\nAll done!")

    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()

    finally:
        driver.quit()
        print("\nBrowser closed.")


if __name__ == '__main__':
    main()


"""
The S3 structure will look like:

Your final S3 bucket structure will be:

AWS_STORAGE_BUCKET_NAME/
  users/                          ← your existing app data (don't touch)
    {username}.json
  auth/
    tokens.json
  uploads/                        ← your existing contract files (don't touch)
    {user_id}/{contract_id}/...

  scrapes/                        ← new scrape data lives here
    caleprocure/
      events/
        1234_5678.json            ← one per event, uploaded immediately
        9999_0001.json
      attachments/
        1234_5678/
          rfp.pdf
      all_events.json             ← combined, uploaded at the end
"""